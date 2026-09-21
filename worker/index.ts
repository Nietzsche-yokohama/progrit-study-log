import type { KVNamespace } from '@cloudflare/workers-types';
import { PROGRIT_SEED, type SeedRow } from './progrit-seed';

export interface Env {
  PROGRIT_KV: KVNamespace;
  SLACK_BOT_TOKEN?: string;
  APP_TOKEN?: string;
}

// CORSはダッシュボードの配信元と開発用localhostのみに限定する（他Workerと方針統一）。
const PROD_ORIGIN = 'https://progrit-study-log.pages.dev';

function corsFor(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') ?? '';
  const allowed =
    origin === PROD_ORIGIN ||
    origin.endsWith('.progrit-study-log.pages.dev') || // Pages のプレビューデプロイ
    /^http:\/\/localhost(:\d+)?$/.test(origin);
  return {
    'Access-Control-Allow-Origin': allowed ? origin : PROD_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    Vary: 'Origin',
  };
}

interface SlackMessage {
  text: string;
  ts: string;
  user?: string;
  bot_id?: string;
}

// 旧形式（v2026.08〜09）でKVに残っている「既知科目に当てはまらなかった行」。
// 現在は読み込み時に x（自動検出科目）または固定科目へ移行するためだけに残している。
interface UnknownEntry {
  label: string;
  min: number;
}

export interface ProgritDay {
  d: number;
  date: string;
  dow: string;
  dowIdx: number;
  // ── 固定科目（SUBJECTS と1対1対応。キー名はKV・シード・フロントで共有） ──
  s: number;  // シャドーイング
  sp: number; // 速読
  o: number;  // 口頭英作文（Day130から「瞬間英作文」）
  v: number;  // 単語
  li: number; // 多聴
  sc: number; // 1分間スピーチ（Day57から）
  rp: number; // リピーティング（Day71から）
  oe: number; // オンライン英会話（Day149から）
  // ── 自動検出科目 ──
  // 固定科目のどれにも当てはまらなかった「科目名 N分」行を、正規化した科目名をキーに
  // そのまま集計する。Slackに新しい科目が増えても、コードを直さなくても集計・表示に
  // 自動で組み込まれる（/api/progrit の summary.subjects に auto:true で出てくる）。
  x: Record<string, number>;
  unknown?: UnknownEntry[]; // 旧形式。読み込み時に migrateLegacyDay で x / 固定科目へ移行済み
}

// 固定科目のキー（ProgritDay の数値プロパティ名）
export type SubjectKey = 's' | 'sp' | 'o' | 'v' | 'li' | 'sc' | 'rp' | 'oe';

export interface SubjectDef {
  key: SubjectKey;
  label: string;   // 表示名（フロントはこれをそのまま使う。クール別の言い換えはフロント側）
  pattern: string; // Slack本文中の科目名パターン（正規表現ソース）。後ろに続く「N分」を拾う
}

// ─────────────────────────────────────────────────────────────────────────
// 科目レジストリ（固定科目）。新しい科目を「名前付きで」扱いたいときはここに1行足すだけ。
//   - フロント（dashboard.js / progrit-weekly.html）は summary.subjects を見て描画するので、
//     ここに足すだけで集計・グラフ・凡例に反映される（色はフロントの既定パレットから自動割当。
//     好みの色にしたければフロントの SUBJECT_COLORS / CAT_META に任意で追記）。
//   - ここに足さなくても、Slackに「科目名 N分」の行があれば自動検出科目（x）として
//     集計・表示に組み込まれる。固定科目にする利点は、①表記ゆれ（別名・括弧書き）を
//     pattern で吸収できる、②行の途中にあっても拾える、③キーが短く安定する、の3点。
//   - pattern は互いに重ならないこと（重なると同じ行を二重に数える）。
//   - 過去に別名だった科目は pattern の選択肢で吸収する（口頭英作文→瞬間英作文）。
// ─────────────────────────────────────────────────────────────────────────
export const SUBJECTS: SubjectDef[] = [
  { key: 's',  label: 'シャドーイング', pattern: 'シャドーイング' },
  { key: 'sp', label: '速読',           pattern: '速読' },
  // Day130から「口頭英作文」→「瞬間英作文」に改名。同一科目として o に合算する。
  { key: 'o',  label: '瞬間英作文',     pattern: '(?:口頭|瞬間)英作文' },
  { key: 'v',  label: '単語',           pattern: '単語' },
  { key: 'li', label: '多聴',           pattern: '多聴' },
  // 「1分間スピーチ」等の表記ゆれを拾うため「スピーチ」で照合する。
  // sumMin はキーワードの後ろの数字を読むので、前置きの「1分間」は誤検出しない。
  { key: 'sc', label: '1分間スピーチ',  pattern: 'スピーチ' },
  { key: 'rp', label: 'リピーティング', pattern: 'リピーティング' },
  // Day149から追加。「英会話 30分」「オンライン英会話（Cambly）25分」のどちらも拾う。
  { key: 'oe', label: 'オンライン英会話', pattern: '(?:オンライン)?英会話' },
];

// 「科目名 N分」の形をしていても学習項目ではない行。自動検出から除外する。
// 集計行や休憩などが科目として登録されてしまったら、ここに追記する。
const IGNORE_LABELS = /^(合計|小計|総計|計|トータル|total|目標|残り|休憩|移動|通勤)$/i;

// 自動検出科目の名前として妥当な最大文字数。これより長い行は文章とみなして拾わない
// （例:「今日は電車で単語帳を見ていたら 30分」のような一文を科目にしない）。
const MAX_AUTO_LABEL_LEN = 20;

// 学習1日目の実日付。d番号から実日付を導出する（Slackの投稿日時は
// 後追い・まとめ投稿でずれるため、日付の基準には使わない）。
const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
const BASE_UTC = Date.UTC(2026, 3, 24); // 2026-04-24 = 学習1日目

export function makeDay(
  d: number, s: number, sp: number, o: number, v: number, li: number,
  sc = 0, rp = 0, oe = 0, x: Record<string, number> = {},
): ProgritDay {
  const dt = new Date(BASE_UTC + (d - 1) * 86400000);
  const dowIdx = dt.getUTCDay();
  return {
    d,
    date: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`,
    dow: DOW_JP[dowIdx],
    dowIdx,
    s, sp, o, v, li, sc, rp, oe, x,
  };
}

function makeDayFromRow(t: SeedRow): ProgritDay {
  return makeDay(t[0], t[1], t[2], t[3], t[4], t[5], t[6] ?? 0, t[7] ?? 0);
}

// 第一クール／第二クールの境目。Slack本文でDay92が「ネクストコース1日目」と
// 明言されているため、Day91までを第一クール、Day92以降を第二クールとして固定する。
// 第三クールが始まったら CYCLE_START_DAYS に開始Dayを追加し、buildCycles にも定義を足すこと。
const CYCLE_BOUNDARY_DAY = 91;
const CYCLE_START_DAYS = [1, CYCLE_BOUNDARY_DAY + 1];

// Slackの「N日目」を、第一クールから通算したDay番号に直す。
// 第二クール以降の投稿は「そのクールのN日目」で書く運用にした（例:「50日目」= 通算Day141）。
// 通算で書かれた投稿（「139日目」）もそのまま通す必要があるため、各クールの開始Dayを
// 基点にした候補（N, N+91, …）のうち、投稿日時にいちばん近い実日付になるものを採る。
//   6/11 に投稿された「48日目」→ Day48（第一クール）
//   9/10 に投稿された「48日目」→ Day139（第二クール48日目 = 9/9）
//   9/10 に投稿された「139日目」→ Day139（通算表記もそのまま通る）
// 候補同士は91日以上離れているので、数日〜数週間の後追い投稿でも取り違えない。
export function resolveAbsoluteDay(n: number, tsSec: number): number {
  if (!(tsSec > 0)) return n;
  const postedElapsedDays = (tsSec * 1000 - BASE_UTC) / 86400000; // 学習1日目からの経過日数
  let best = n;
  let bestDist = Infinity;
  for (const start of CYCLE_START_DAYS) {
    const cand = n + start - 1;
    const dist = Math.abs(cand - 1 - postedElapsedDays);
    if (dist < bestDist) {
      best = cand;
      bestDist = dist;
    }
  }
  return best;
}

// 第一クール(d1〜CYCLE_BOUNDARY_DAY)はリポジトリ内のシード(progrit-seed.ts)が正本。
// KVの内容がどうであれ、毎回シードの値に戻す（冪等）。誤った日番号の投稿で
// KV側が上書きされても、次のリクエストで元に戻り、次の差分取得時に永続化される。
export function applyLockedSeed(days: ProgritDay[]): ProgritDay[] {
  const map = new Map<number, ProgritDay>(days.map((d) => [d.d, d]));
  for (const t of PROGRIT_SEED) map.set(t[0], makeDayFromRow(t));
  return Array.from(map.values()).sort((a, b) => a.d - b.d);
}

// Slackから取り込めなかった投稿の手動補完。KVにその日が無いときだけ追加する
// （Slackに再投稿されれば、そちらが勝つ）。Slack上でメッセージを編集しても ts は
// 変わらず差分取得（oldest=lastMsgTs）に乗らないため、編集で直した投稿はここで補う。
// Slackの投稿本文をそのまま書く（通常のパーサーで解釈するので、科目が増えても
// 書き方は変わらない）。「N日目」は通算で書く（ts を持たないためクール補正はかからない）。
const MANUAL_POSTS: string[] = [
  // Day139(9/9): 「48日目」と誤記して投稿し、Slack上で「139日目」に編集済み。
  `プログリットで学習139日目
瞬間英作文 18分
瞬間英作文 28分
瞬間英作文 27分
瞬間英作文 25分
単語(日→英) 12分`,
];

export function applyManualPosts(days: ProgritDay[], posts: string[] = MANUAL_POSTS): ProgritDay[] {
  const map = new Map<number, ProgritDay>(days.map((d) => [d.d, d]));
  const manual = parseProgritMessages(posts.map((text) => ({ text, ts: '0' })));
  for (const d of manual) if (!map.has(d.d)) map.set(d.d, d);
  return Array.from(map.values()).sort((a, b) => a.d - b.d);
}

// 科目名の正規化。行頭の箇条書き記号、括弧書き（教材名など）、末尾の区切り記号を落とす。
//   「・オンライン英会話（Cambly）：」→「オンライン英会話」
export function normalizeLabel(raw: string): string {
  return raw
    .replace(/[（(][^（）()]*[）)]/g, '')          // 括弧書きを除去
    .replace(/^[\s　・\-–—•*●○◎■□▪☆★]+/, '')      // 行頭の箇条書き記号
    .replace(/[\s　:：・\-–—=＝]+$/, '')            // 末尾の区切り記号
    .replace(/[\s　]+/g, ' ')
    .trim();
}

// 固定科目のいずれかに該当する科目名か（該当すればそのキー）。
export function matchSubjectKey(label: string): SubjectKey | null {
  for (const s of SUBJECTS) if (new RegExp(s.pattern).test(label)) return s.key;
  return null;
}

// 固定科目のどれにも当てはまらない「科目名 N分」行を、科目名ごとに合算して返す。
// 固定科目の文字を含む行は sumMin 側で数えるので、ここでは行ごと読み飛ばす
// （「シャドーイング 30分」に加えて「シャドーイング」を科目登録してしまわないため）。
const KNOWN_RE = new RegExp(SUBJECTS.map((s) => s.pattern).join('|'));
// 行全体が「科目名 N分（補足）」の形。科目名に「分」を含めないことで、1行に複数科目が
// 並ぶケース（下の INLINE_ENTRY_RE で分解する）を1つの科目として誤認しない。
const LINE_ENTRY_RE = /^[\s　]*([^分]+?)[\s　:：]*(\d+)\s*分間?(?:[\s　]*[（(][^（）()]*[）)])?[\s　]*$/;
const INLINE_ENTRY_RE = /([^\d分\n]+?)[\s　:：]*(\d+)\s*分間?/g;

export function findExtraEntries(block: string): Record<string, number> {
  const result: Record<string, number> = {};
  const add = (rawLabel: string, min: number) => {
    const label = normalizeLabel(rawLabel);
    if (!label || label.length > MAX_AUTO_LABEL_LEN) return;
    if (IGNORE_LABELS.test(label)) return;
    if (!(min > 0)) return;
    result[label] = (result[label] ?? 0) + min;
  };
  for (const rawLine of block.split('\n')) {
    if (!rawLine.includes('分') || KNOWN_RE.test(rawLine)) continue;
    const m = rawLine.match(LINE_ENTRY_RE);
    if (m) {
      add(m[1], parseInt(m[2], 10));
      continue;
    }
    // 1行に複数の科目が並ぶ場合（「英語日記 15分 音読 10分」）
    for (const im of rawLine.matchAll(INLINE_ENTRY_RE)) add(im[1], parseInt(im[2], 10));
  }
  return result;
}

// 指定科目の「○分」を全て合計する。1日に同じ科目を複数回書いても取りこぼさない。
function sumMin(text: string, pattern: string): number {
  const re = new RegExp('(?:' + pattern + ')[^0-9]*?(\\d+)\\s*分', 'g');
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) total += parseInt(m[1], 10);
  return total;
}

// 1日分のブロック（「N日目」ヘッダ以降の本文）を ProgritDay にする。
export function parseDayBlock(day: number, block: string): ProgritDay {
  const dayRec = makeDay(day, 0, 0, 0, 0, 0);
  for (const s of SUBJECTS) dayRec[s.key] = sumMin(block, s.pattern);
  dayRec.x = findExtraEntries(block);
  return dayRec;
}

export function parseProgritMessages(messages: SlackMessage[]): ProgritDay[] {
  const headerRe = /プログリットで学習\s*(\d+)\s*日目/g;
  const dayMap = new Map<number, ProgritDay>();

  // tsの昇順（古い→新しい）で処理する。同じ日番号が複数投稿された場合、
  // 後から処理した新しい投稿が上書きして勝つ（再投稿で内容を訂正できる）。
  const ordered = [...messages].sort((a, b) => parseFloat(a.ts || '0') - parseFloat(b.ts || '0'));

  for (const msg of ordered) {
    const text = (msg.text || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    );

    // 1つのメッセージに複数の「N日目」が含まれる場合に備え、日付ヘッダごとに分割する。
    const heads = Array.from(text.matchAll(headerRe));
    for (let i = 0; i < heads.length; i++) {
      // 「N日目」はクール内の相対日数の可能性があるので、投稿日時から通算Dayに直す
      const day = resolveAbsoluteDay(parseInt(heads[i][1], 10), parseFloat(msg.ts || '0'));
      const start = (heads[i].index ?? 0) + heads[i][0].length;
      const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length;
      const block = text.slice(start, end);

      // 同じ日番号の再投稿は最新を優先（上書き）
      dayMap.set(day, parseDayBlock(day, block));
    }
  }

  return Array.from(dayMap.values()).sort((a, b) => a.d - b.d);
}

// KVに保存済みの旧形式レコードを現行形式に揃える（冪等）。
//   - 固定科目のキーが無ければ 0、x が無ければ {} を補う（科目追加前に保存された日）
//   - 旧パーサーが unknown に退避していた行は、いまの固定科目に該当すればそこへ、
//     しなければ x（自動検出科目）へ付け替える。Slackの90日保持で元メッセージが
//     消えていても直せるよう、再取得ではなく保存データ側を補正する。
export function migrateLegacyDay(d: ProgritDay): ProgritDay {
  for (const s of SUBJECTS) if (typeof d[s.key] !== 'number') d[s.key] = 0;
  if (!d.x || typeof d.x !== 'object') d.x = {};
  if (d.unknown && d.unknown.length > 0) {
    for (const u of d.unknown) {
      const key = matchSubjectKey(u.label);
      if (key) {
        d[key] += u.min;
      } else {
        const label = normalizeLabel(u.label);
        if (label && !IGNORE_LABELS.test(label)) d.x[label] = (d.x[label] ?? 0) + u.min;
      }
    }
  }
  delete d.unknown;
  return d;
}

export interface SubjectStat {
  key: string;      // 固定科目: SubjectKey ／ 自動検出科目: 'x:' + 科目名
  label: string;    // 表示名
  auto: boolean;    // true = 自動検出科目（day.x[label] に分数が入っている）
  totalMin: number;
  activeDays: number;       // その科目を1分以上やった日数
  firstDay: number | null;  // 最初にやった日（通算Day）
  lastDay: number | null;
}

export function minutesOf(d: ProgritDay, s: Pick<SubjectStat, 'key' | 'label' | 'auto'>): number {
  return s.auto ? (d.x?.[s.label] ?? 0) : ((d as unknown as Record<string, number>)[s.key] ?? 0);
}

export function dayTotal(d: ProgritDay): number {
  let t = 0;
  for (const s of SUBJECTS) t += d[s.key] ?? 0;
  for (const v of Object.values(d.x ?? {})) t += v;
  return t;
}

// 直近この日数以内に初めて登場した科目を「新しく加わった科目」として summary.newSubjects に出す。
// フロントはこれをお知らせバナーに表示する（自動検出の誤検出に気付けるようにするため）。
const NEW_SUBJECT_WINDOW_DAYS = 14;

// 全期間の合計・科目一覧をサーバー側で一度だけ計算する。
// フロント側（dashboard.js / progrit-weekly.html）は必ずこの値を表示に使い、
// 各ページで科目のリストや合計を決め打ちしない。二重定義をやめることで
// 「新科目が片方のページだけ抜けている」「ページ間で合計が食い違う」再発を構造的に防ぐ。
export function summarize(days: ProgritDay[]) {
  const totals = days.map(dayTotal);
  const totalMinutes = totals.reduce((a, b) => a + b, 0);
  const activeDays = totals.filter((t) => t > 0).length;

  // 固定科目は定義順、自動検出科目は初登場日順
  const defs: Array<Pick<SubjectStat, 'key' | 'label' | 'auto'>> = SUBJECTS.map((s) => ({ key: s.key, label: s.label, auto: false }));
  const autoLabels = new Map<string, number>(); // label -> firstDay
  for (const d of days) {
    for (const [label, min] of Object.entries(d.x ?? {})) {
      if (min > 0 && !autoLabels.has(label)) autoLabels.set(label, d.d);
    }
  }
  for (const [label] of Array.from(autoLabels).sort((a, b) => a[1] - b[1])) {
    defs.push({ key: 'x:' + label, label, auto: true });
  }

  const subjects: SubjectStat[] = defs.map((def) => {
    let totalMin = 0, active = 0, firstDay: number | null = null, lastDay: number | null = null;
    for (const d of days) {
      const m = minutesOf(d, def);
      if (m <= 0) continue;
      totalMin += m;
      active++;
      if (firstDay === null) firstDay = d.d;
      lastDay = d.d;
    }
    return { ...def, totalMin, activeDays: active, firstDay, lastDay };
  });

  const maxDay = days.length ? days[days.length - 1].d : 0;
  const newSubjects = subjects.filter(
    (s) => s.firstDay !== null && s.firstDay > maxDay - NEW_SUBJECT_WINDOW_DAYS,
  );

  return { totalDays: days.length, activeDays, totalMinutes, subjects, newSubjects };
}

// 各クールの集計もsummarize()を再利用して計算する。フロント側（クール別タブ）は
// このcyclesをそのまま表示に使い、クールの境目や合計をページ側で持たない。
function buildCycles(days: ProgritDay[]) {
  const cycle1Days = days.filter((d) => d.d <= CYCLE_BOUNDARY_DAY);
  const cycle2Days = days.filter((d) => d.d > CYCLE_BOUNDARY_DAY);
  return [
    { key: 'cycle1', label: '第一クール', fromDay: 1, toDay: CYCLE_BOUNDARY_DAY, ...summarize(cycle1Days) },
    { key: 'cycle2', label: '第二クール', fromDay: CYCLE_BOUNDARY_DAY + 1, toDay: null as number | null, ...summarize(cycle2Days) },
  ];
}

export function buildPayload(fetchedAt: number, days: ProgritDay[]) {
  return { fetchedAt, days, summary: summarize(days), cycles: buildCycles(days) };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const CORS = corsFor(request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname !== '/api/progrit' || request.method !== 'GET') {
      return new Response('Not Found', { status: 404, headers: CORS });
    }

    // Bearer 認証（他Workerと方針統一）。シークレット APP_TOKEN が未設定の間は
    // 従来どおり素通しにし、設定した時点で保護が有効になる（デプロイ直後に
    // ダッシュボードを締め出さないための移行措置）。
    const appToken = env.APP_TOKEN?.trim();
    if (appToken && request.headers.get('Authorization') !== `Bearer ${appToken}`) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    // master_v7: TTLなし永続保存。days全履歴 + lastMsgTs（最後に取得したSlackメッセージのts）
    const MASTER_KEY = 'progrit_master_v7';
    const REFRESH_MS = 30 * 60 * 1000; // 30分ごとにSlackから差分取得

    interface ProgritMaster {
      days: ProgritDay[];
      lastMsgTs: string; // Slackのts（秒.マイクロ秒）、次回はこれより新しいものだけ取得
      savedAt: number;
    }

    // KVから永続データを読み込む
    let master: ProgritMaster = { days: [], lastMsgTs: '0', savedAt: 0 };
    try {
      const stored = await env.PROGRIT_KV.get(MASTER_KEY);
      if (stored) master = JSON.parse(stored) as ProgritMaster;
    } catch { /* 初回 or 破損 → 空スタート */ }

    // 第一クール(d1〜91)は常にリポジトリ内のシードの値に固定する。KVが空（初回 or KV消失）
    // ならこれが初期データになり、KVにデータがあっても第一クール分はシードで上書きし直す。
    // Slackは90日でメッセージが消えるため、シードが過去データの恒久バックアップになる。
    master.days = applyLockedSeed(master.days);

    // Slackから取り込めなかった投稿（編集で直した投稿など）を補完する。既にあればno-op。
    master.days = applyManualPosts(master.days);

    // 科目追加前・旧パーサー時代に保存されたレコードを現行形式に揃える（冪等）。
    // 次のSlack差分取得（X-Cache: MISS）のタイミングで補正後の状態が永続化される。
    master.days.forEach(migrateLegacyDay);

    // 30分以内に更新済みならキャッシュ返却
    if (Date.now() - master.savedAt < REFRESH_MS && master.days.length > 0) {
      return new Response(JSON.stringify(buildPayload(master.savedAt, master.days)), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'HIT' },
      });
    }

    if (!env.SLACK_BOT_TOKEN) {
      // トークン未設定でも保存済みデータがあれば返す
      if (master.days.length > 0) {
        return new Response(JSON.stringify(buildPayload(master.savedAt, master.days)), {
          headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'STORED' },
        });
      }
      return new Response(JSON.stringify({ error: 'SLACK_BOT_TOKEN not configured' }), {
        status: 503, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    try {
      const channel = 'C08QDEH5H8V';
      let newMessages: SlackMessage[] = [];
      let cursor = '';

      // lastMsgTs より新しいメッセージだけ取得（初回は全件）
      do {
        const params = new URLSearchParams({ channel, limit: '200', oldest: master.lastMsgTs });
        if (cursor) params.set('cursor', cursor);

        const slackRes = await fetch(
          `https://slack.com/api/conversations.history?${params}`,
          { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } },
        );
        const slackData = await slackRes.json<{
          ok: boolean;
          messages: SlackMessage[];
          response_metadata?: { next_cursor: string };
        }>();

        if (!slackData.ok) break;
        newMessages = newMessages.concat(slackData.messages || []);
        cursor = slackData.response_metadata?.next_cursor ?? '';
      } while (cursor);

      if (newMessages.length > 0) {
        // 新しいメッセージを既存daysとマージ（同じ日番号は上書き）
        const newDays = parseProgritMessages(newMessages);
        const dayMap = new Map<number, ProgritDay>(master.days.map((d) => [d.d, d]));
        // 第一クール(d1〜91)は終了済みの確定値（シードが正本）なので、Slack再取得で上書きしない。
        // 誤った日番号で投稿されても第一クールの数字は動かない。
        for (const d of newDays) if (d.d > CYCLE_BOUNDARY_DAY) dayMap.set(d.d, d);
        master.days = Array.from(dayMap.values()).sort((a, b) => a.d - b.d);

        // 最新メッセージのts（Slackはtimestamp降順で返す）を記録
        const latestTs = newMessages.reduce((max, m) =>
          parseFloat(m.ts) > parseFloat(max) ? m.ts : max, master.lastMsgTs);
        master.lastMsgTs = latestTs;
      }

      master.savedAt = Date.now();

      // TTLなしで永続保存（KV上限まで消えない）
      await env.PROGRIT_KV.put(MASTER_KEY, JSON.stringify(master));

      return new Response(JSON.stringify(buildPayload(master.savedAt, master.days)), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'MISS' },
      });
    } catch (e) {
      console.error('progrit fetch error:', e);
      // エラーでも保存済みデータがあれば返す（サービス継続）
      if (master.days.length > 0) {
        return new Response(JSON.stringify(buildPayload(master.savedAt, master.days)), {
          headers: { ...CORS, 'Content-Type': 'application/json', 'X-Cache': 'STORED' },
        });
      }
      return new Response(JSON.stringify({ error: 'Slack fetch failed' }), {
        status: 502, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  },
};
