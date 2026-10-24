// 第二クール（Day92〜182）のシード worker/progrit-seed-cycle2.ts を生成する一回限りのスクリプト。
//   npx esbuild scripts/build-cycle2-seed.ts --bundle --platform=node --format=esm \
//     --outfile=.test-out/build-cycle2-seed.mjs && node .test-out/build-cycle2-seed.mjs \
//     data-dump/slack-history.json data-dump/kv-master.json worker/progrit-seed-cycle2.ts
// 入力:
//   slack-history.json … conversations.history の全メッセージ（{ts,text,...}[]）。Slack の90日保持で
//                        残っている分（Day95〜）はこれを Worker と同じパーサーで解釈した値を正本にする。
//   kv-master.json     … 現在の KV（progrit_master_v7）。Slack に無い日（Day92〜94）はこれを使う。
// 出力の各行: [d, s, sp, o, v, li, sc, rp, oe, x]
import { readFileSync, writeFileSync } from 'node:fs';
import { parseProgritMessages, migrateLegacyDay, SUBJECTS, type ProgritDay } from '../worker/index';

const [slackPath, kvPath, outPath] = process.argv.slice(2);
if (!slackPath || !kvPath || !outPath) {
  console.error('usage: build-cycle2-seed <slack-history.json> <kv-master.json> <out.ts>');
  process.exit(1);
}
const FROM = 92, TO = 182;

const slackMsgs = JSON.parse(readFileSync(slackPath, 'utf8')) as Array<{ ts: string; text: string; subtype?: string }>;
const slackDays = new Map(
  parseProgritMessages(slackMsgs.filter((m) => !m.subtype || m.subtype === 'thread_broadcast'))
    .filter((d) => d.d >= FROM && d.d <= TO)
    .map((d) => [d.d, d]),
);
const kv = JSON.parse(readFileSync(kvPath, 'utf8')) as { days: ProgritDay[] };
const kvDays = new Map(kv.days.filter((d) => d.d >= FROM && d.d <= TO).map((d) => [d.d, d]));

const rows: string[] = [];
const notes: string[] = [];
const diffs: string[] = [];
const rpOf = (d: ProgritDay) => (typeof d.rp === 'number' ? d.rp : 0);

for (let d = FROM; d <= TO; d++) {
  const s = slackDays.get(d);
  const k = kvDays.get(d);
  let row: ProgritDay | undefined;
  let src = '';
  if (s) {
    row = s;
    src = 'slack';
    if (k) {
      // Slack 再解釈と KV の突き合わせ。sp/rp は KV 側で合算されている可能性があるので合計で比べる。
      const kk = migrateLegacyDay({ ...k, x: { ...(k.x ?? {}) } });
      const fieldDiffs: string[] = [];
      for (const sub of SUBJECTS) {
        if (sub.key === 'sp' || sub.key === 'rp') continue;
        if ((s as unknown as Record<string, number>)[sub.key] !== (kk as unknown as Record<string, number>)[sub.key]) {
          fieldDiffs.push(`${sub.key}: slack=${(s as unknown as Record<string, number>)[sub.key]} kv=${(kk as unknown as Record<string, number>)[sub.key]}`);
        }
      }
      if (s.sp + rpOf(s) !== kk.sp + rpOf(kk)) fieldDiffs.push(`sp+rp: slack=${s.sp + rpOf(s)} kv=${kk.sp + rpOf(kk)}`);
      if (JSON.stringify(s.x ?? {}) !== JSON.stringify(kk.x ?? {})) fieldDiffs.push(`x: slack=${JSON.stringify(s.x)} kv=${JSON.stringify(kk.x)}`);
      if (fieldDiffs.length) diffs.push(`Day${d}: ${fieldDiffs.join(', ')}`);
    }
  } else if (k) {
    row = migrateLegacyDay({ ...k, x: { ...(k.x ?? {}) } });
    src = 'kv';
    notes.push(`Day${d}: Slack に無いため KV の値（sp にリピーティングが合算済みの可能性あり）`);
  }
  if (!row) continue;
  const x = row.x && Object.keys(row.x).length ? `, ${JSON.stringify(row.x)}` : '';
  rows.push(`  [${d}, ${row.s}, ${row.sp}, ${row.o}, ${row.v}, ${row.li}, ${row.sc}, ${rpOf(row)}, ${row.oe}${x}], // ${src}`);
}

const out = `// PROGRIT 第二クール d92(2026-07-24)〜d182(2026-10-22) の確定済み学習記録。
// scripts/build-cycle2-seed.ts が Slack の全履歴（Worker と同じパーサーで解釈）と KV から生成した。
// 第二クールは終了しており、今後この値が変わることはない。worker は第一クールと同様に
// この表を正本として扱う（applyLockedSeed で毎回この値に戻し、Slack の差分取得では更新しない）。
//
// 各行: [d, s, sp, o, v, li, sc, rp, oe, x?]（単位: 分）
//   s=シャドーイング sp=速読 o=口頭英作文/瞬間英作文 v=単語 li=多聴 sc=1分間スピーチ
//   rp=リピーティング oe=オンライン英会話 x=自動検出科目（{科目名: 分}）
${notes.length ? '//\n// 注記:\n' + notes.map((n) => '//   ' + n).join('\n') + '\n' : ''}export type SeedRow2 = [number, number, number, number, number, number, number, number, number, Record<string, number>?];
export const PROGRIT_SEED_CYCLE2: SeedRow2[] = [
${rows.join('\n')}
];
`;
writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${rows.length} days (slack=${[...slackDays.keys()].length}, kv-only=${notes.length})`);
if (diffs.length) {
  console.log('Slack 再解釈と KV の差分（確認が必要）:');
  for (const l of diffs) console.log('  ' + l);
} else {
  console.log('Slack 再解釈と KV の差分: なし');
}
