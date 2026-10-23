// パーサーと集計の回帰テスト。`npm test` で実行する（esbuild でバンドルして node --test）。
// 「Slackに新しい科目が増えたら、コードを直さなくても集計・summary.subjects に載ること」を
// ここで固定しておく。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseProgritMessages, findExtraEntries, normalizeLabel, migrateLegacyDay,
  summarize, dayTotal, applyManualPosts, applyLockedSeed, makeDay, SUBJECTS,
  buildCycles, CYCLES, mergeFetchedDays, LOCKED_THROUGH_DAY, type ProgritDay,
} from './index';

const post = (text: string, ts = '0') => ({ text, ts });

test('固定科目は行の途中・括弧付きでも拾い、同じ科目の複数行は合算する', () => {
  const [d] = parseProgritMessages([post(`プログリットで学習140日目
シャドーイング（CosmoPier） 45分
単語(日→英) 12分
瞬間英作文 18分
瞬間英作文 28分
1分間スピーチ 20分
オンライン英会話（Cambly）25分`)]);
  assert.equal(d.d, 140);
  assert.equal(d.s, 45);
  assert.equal(d.v, 12);
  assert.equal(d.o, 46);
  assert.equal(d.sc, 20);
  assert.equal(d.oe, 25);
  assert.deepEqual(d.x, {});
  assert.equal(dayTotal(d), 45 + 12 + 46 + 20 + 25);
});

test('「英会話 30分」だけでもオンライン英会話として拾う（二重計上しない）', () => {
  const [d] = parseProgritMessages([post('プログリットで学習149日目\n英会話 30分')]);
  assert.equal(d.oe, 30);
  assert.deepEqual(d.x, {});
});

test('未知の科目は自動検出科目 x に入り、合計と summary.subjects に載る', () => {
  const days = parseProgritMessages([post(`プログリットで学習150日目
シャドーイング 30分
・英語日記：15分
音読(教材A) 10分
音読 5分
合計 60分`)]);
  const d = days[0];
  assert.equal(d.s, 30);
  assert.deepEqual(d.x, { '英語日記': 15, '音読': 15 });
  assert.equal(dayTotal(d), 60); // 「合計」行は数えない

  const sum = summarize(days);
  assert.equal(sum.totalMinutes, 60);
  const auto = sum.subjects.filter((s) => s.auto);
  assert.deepEqual(auto.map((s) => [s.key, s.label, s.totalMin, s.firstDay]), [
    ['x:英語日記', '英語日記', 15, 150],
    ['x:音読', '音読', 15, 150],
  ]);
  // 固定科目は定義順で先に並ぶ
  assert.deepEqual(sum.subjects.slice(0, SUBJECTS.length).map((s) => s.key), SUBJECTS.map((s) => s.key));
  // 直近14日以内に初登場した科目は newSubjects に出る
  assert.deepEqual(sum.newSubjects.map((s) => s.label).sort(), ['シャドーイング', '英語日記', '音読']);
});

test('1行に複数科目が並んでも分けて拾う／文章っぽい長い行は拾わない', () => {
  assert.deepEqual(findExtraEntries('英語日記 15分 音読 10分'), { '英語日記': 15, '音読': 10 });
  assert.deepEqual(findExtraEntries('今日は電車の中でずっと英語のポッドキャストを聞いていました 30分'), {});
  assert.deepEqual(findExtraEntries('TOEIC Part5 10分'), { 'TOEIC Part5': 10 });
  assert.deepEqual(findExtraEntries('休憩 10分\n目標 150分'), {});
});

test('normalizeLabel は箇条書き・括弧・末尾記号を落とす', () => {
  assert.equal(normalizeLabel('・オンライン英会話（Cambly）：'), 'オンライン英会話');
  assert.equal(normalizeLabel('- 音読 -'), '音読');
  assert.equal(normalizeLabel('　英語日記　'), '英語日記');
});

test('旧形式（unknown）のレコードは固定科目 or x に移行され、冪等', () => {
  const d = {
    ...makeDay(149, 0, 0, 40, 10, 0),
    unknown: [{ label: 'オンライン英会話', min: 30 }, { label: '瞬間英作文', min: 5 }, { label: '音読', min: 7 }],
  } as ProgritDay;
  // 科目追加前のレコードを模す（oe / x が無い）
  delete (d as Partial<ProgritDay>).oe;
  delete (d as Partial<ProgritDay>).x;

  migrateLegacyDay(d);
  assert.equal(d.oe, 30);
  assert.equal(d.o, 45);
  assert.deepEqual(d.x, { '音読': 7 });
  assert.equal(d.unknown, undefined);
  assert.equal(dayTotal(d), 30 + 45 + 10 + 7);

  migrateLegacyDay(d);
  assert.equal(d.oe, 30);
  assert.equal(d.o, 45);
});

test('手動補完はSlack本文の形式で書け、既にある日は上書きしない', () => {
  const base = applyLockedSeed([]);
  const withManual = applyManualPosts(base);
  const d139 = withManual.find((d) => d.d === 139)!;
  assert.equal(d139.o, 98);
  assert.equal(d139.v, 12);

  const existing = [makeDay(139, 1, 0, 0, 0, 0)];
  assert.equal(applyManualPosts(existing).find((d) => d.d === 139)!.s, 1);

  const custom = applyManualPosts([], ['プログリットで学習200日目\n新科目 9分']);
  assert.deepEqual(custom[0].x, { '新科目': 9 });
});

test('第二クールの「N日目」は投稿日時から通算Dayに直す', () => {
  const sep10 = String(Date.UTC(2026, 8, 10, 3) / 1000); // 2026-09-10
  const [d] = parseProgritMessages([post('プログリットで学習48日目\n単語 5分', sep10)]);
  assert.equal(d.d, 139);
});

test('同じ日番号の再投稿は新しい方が勝つ', () => {
  const days = parseProgritMessages([
    post('プログリットで学習150日目\n単語 5分', '100'),
    post('プログリットで学習150日目\n単語 9分', '200'),
  ]);
  assert.equal(days.length, 1);
  assert.equal(days[0].v, 9);
});

test('第三クールの「N日目」は Day183 起点で通算Dayに直す（第二クールの後追い投稿も崩れない）', () => {
  const ts = (m: number, d: number) => String(Date.UTC(2026, m - 1, d, 3) / 1000); // JST 12時ごろ
  // 第二クール最終日「91日目」(10/22) → Day182
  assert.equal(parseProgritMessages([post('プログリットで学習91日目\n単語 5分', ts(10, 22))])[0].d, 182);
  // 第三クール「1日目」(10/23) → Day183
  assert.equal(parseProgritMessages([post('プログリットで学習1日目\n単語 5分', ts(10, 23))])[0].d, 183);
  // 第三クール「3日目」を数日遅れ(10/28)でまとめ投稿 → Day185
  assert.equal(parseProgritMessages([post('プログリットで学習3日目\n単語 5分', ts(10, 28))])[0].d, 185);
  // 第三クール開始後に第二クール「90日目」を後追い投稿(10/25) → Day181 のまま
  assert.equal(parseProgritMessages([post('プログリットで学習90日目\n単語 5分', ts(10, 25))])[0].d, 181);
  // 通算表記「183日目」もそのまま通る
  assert.equal(parseProgritMessages([post('プログリットで学習183日目\n単語 5分', ts(10, 23))])[0].d, 183);
});

test('cycles は第一〜第三クールを返し、Day182 は第二クール・Day183 は第三クールに入る', () => {
  const days = [makeDay(91, 10, 0, 0, 0, 0), makeDay(92, 20, 0, 0, 0, 0), makeDay(182, 30, 0, 0, 0, 0), makeDay(183, 40, 0, 0, 0, 0)];
  const cycles = buildCycles(days);
  assert.deepEqual(cycles.map((c) => [c.key, c.label, c.fromDay, c.toDay]), [
    ['cycle1', '第一クール', 1, 91],
    ['cycle2', '第二クール', 92, 182],
    ['cycle3', '第三クール', 183, null],
  ]);
  assert.deepEqual(cycles.map((c) => c.totalMinutes), [10, 50, 40]);
  // 全期間の合計 = 各クールの合計の和（クール間で取りこぼし・二重計上がない）
  assert.equal(summarize(days).totalMinutes, cycles.reduce((a, c) => a + c.totalMinutes, 0));
  assert.deepEqual(CYCLES.map((c) => c.fromDay), [1, 92, 183]);
  assert.equal(makeDay(183, 0, 0, 0, 0, 0).date, '10/23'); // 第三クール1日目 = 2026-10-23
});

test('終了済みクール（Day1〜182）は Slack の再取得で上書きされず、未取得の日だけ埋まる', () => {
  assert.equal(LOCKED_THROUGH_DAY, 182);
  const existing = [makeDay(91, 1, 0, 0, 0, 0), makeDay(100, 10, 0, 0, 0, 0), makeDay(183, 30, 0, 0, 0, 0)];
  const fetched = [
    makeDay(91, 99, 0, 0, 0, 0),   // 第一クール: シードが正本 → 無視
    makeDay(100, 99, 0, 0, 0, 0),  // 第二クール・既存あり → 守る
    makeDay(182, 20, 0, 0, 0, 0),  // 第二クール・未取得 → 追加
    makeDay(183, 40, 0, 0, 0, 0),  // 第三クール（進行中）→ 再投稿で上書き
    makeDay(184, 50, 0, 0, 0, 0),  // 第三クール・新規 → 追加
  ];
  const merged = mergeFetchedDays(existing, fetched);
  assert.deepEqual(merged.map((d) => [d.d, d.s]), [[91, 1], [100, 10], [182, 20], [183, 40], [184, 50]]);
});
