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

interface UnknownEntry {
  label: string; // Slack上の行そのままの科目表記（例:「リピーティング」）
  min: number;
}

interface ProgritDay {
  d: number;
  date: string;
  dow: string;
  dowIdx: number;
  s: number;
  sp: number;
  o: number;
  v: number;
  li: number;
  sc: number; // 1分間スピーチ（途中から追加された科目。過去データには存在しない）
  rp: number; // リピーティング（さらに後から追加された科目。過去データには存在しない）
  unknown: UnknownEntry[]; // 既知科目に当てはまらなかった行（新科目追加の見落とし検知用）
}

// 既知の科目一覧（sumMin の抽出キーワードと1対1対応）。
// Slackに新しい科目が追加されたら、必ずここにも追記すること。
// 追記を忘れても /api/progrit の unknownSubjects に自動で出てくるので気付ける。
// 「口頭英作文」はDay130から「瞬間英作文」に改名された（同一科目として o に合算）。
const KNOWN_SUBJECTS = ['シャドーイング', '速読', '口頭英作文', '瞬間英作文', '単語', '多聴', 'スピーチ', 'リピーティング'];

// 学習1日目の実日付。d番号から実日付を導出する（Slackの投稿日時は
// 後追い・まとめ投稿でずれるため、日付の基準には使わない）。
const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
const BASE_UTC = Date.UTC(2026, 3, 24); // 2026-04-24 = 学習1日目

function makeDay(
  d: number, s: number, sp: number, o: number, v: number, li: number,
  sc = 0, rp = 0, unknown: UnknownEntry[] = [],
): ProgritDay {
  const dt = new Date(BASE_UTC + (d - 1) * 86400000);
  const dowIdx = dt.getUTCDay();
  return {
    d,
    date: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`,
    dow: DOW_JP[dowIdx],
    dowIdx,
    s, sp, o, v, li, sc, rp, unknown,
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
const MANUAL_DAYS: SeedRow[] = [
  // Day139(9/9): 「48日目」と誤記して投稿し、Slack上で「139日目」に編集済み。
  // 瞬間英作文 18+28+27+25=98分、単語(日→英) 12分
  [139, 0, 0, 98, 12, 0],
];

export function applyManualDays(days: ProgritDay[], manual: SeedRow[] = MANUAL_DAYS): ProgritDay[] {
  const map = new Map<number, ProgritDay>(days.map((d) => [d.d, d]));
  for (const t of manual) if (!map.has(t[0])) map.set(t[0], makeDayFromRow(t));
  return Array.from(map.values()).sort((a, b) => a.d - b.d);
}

// ブロック内の「科目名 N分」形式の行のうち、既知科目に一致しないものを拾う。
// 「1分間スピーチ」のように科目名自体に数字を含むケースは行末の数値だけを
// 実測値として扱うため誤検知しない。新科目が追加されたときの取りこぼし検知に使う。
function findUnknownEntries(block: string, knownSubjects: string[]): UnknownEntry[] {
  const knownRe = new RegExp(knownSubjects.join('|'));
  const result: UnknownEntry[] = [];
  for (const rawLine of block.split('\n')) {
    const m = rawLine.match(/^[\s　]*(.+?)[\s　]*(\d+)\s*分\s*$/);
    if (!m) continue;
    const label = m[1].trim();
    if (!label || knownRe.test(label)) continue;
    result.push({ label, min: parseInt(m[2], 10) });
  }
  return result;
}

export function parseProgritMessages(messages: SlackMessage[]): ProgritDay[] {
  // 指定科目の「○分」を全て合計する。1日に同じ科目を複数回書いても取りこぼさない。
  const sumMin = (text: string, subject: string): number => {
    const re = new RegExp(subject + '[^0-9]*?(\\d+)\\s*分', 'g');
    let total = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) total += parseInt(m[1], 10);
    return total;
  };

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

      const s  = sumMin(block, 'シャドーイング');
      const sp = sumMin(block, '速読');
      // Day130から「口頭英作文」→「瞬間英作文」に改名。同一科目なので合算する。
      const o  = sumMin(block, '口頭英作文') + sumMin(block, '瞬間英作文');
      const v  = sumMin(block, '単語');
      const li = sumMin(block, '多聴');
      // 「1分間スピーチ」等の表記ゆれを拾うため「スピーチ」で照合する。
      // sumMin はキーワードの後ろの数字を読むので、前置きの「1分間」は誤検出しない。
      const sc = sumMin(block, 'スピーチ');
      const rp = sumMin(block, 'リピーティング');
      const unknown = findUnknownEntries(block, KNOWN_SUBJECTS);

      // 同じ日番号の再投稿は最新を優先（上書き）
      dayMap.set(day, makeDay(day, s, sp, o, v, li, sc, rp, unknown));
    }
  }

  return Array.from(dayMap.values()).sort((a, b) => a.d - b.d);
}

// Day130の改名（口頭英作文→瞬間英作文）にパーサーが追従する前にSlackから取り込まれ、
// unknown としてKVに保存済みの分を o に付け替える。Slackの90日保持で元メッセージが
// 消えていても直せるよう、再取得ではなく保存データ側を補正する。補正済みならno-op。
function migrateRenamedSubjects(days: ProgritDay[]): void {
  for (const d of days) {
    if (!d.unknown || d.unknown.length === 0) continue;
    d.unknown = d.unknown.filter((u) => {
      if (!u.label.includes('瞬間英作文')) return true;
      d.o += u.min;
      return false;
    });
  }
}

// 全期間の合計・未知科目サマリをサーバー側で一度だけ計算する。
// フロント側（progrit.html / progrit-weekly.html）は必ずこの値を表示に使い、
// 各ページで独自に合計を再計算しない。二重計算をやめることで「ページ間で
// 合計が食い違う」再発を構造的に防ぐ。
function summarize(days: ProgritDay[]) {
  const dayTotal = (d: ProgritDay) =>
    d.s + d.sp + d.o + d.v + d.li + (d.sc || 0) + (d.rp || 0) +
    (d.unknown || []).reduce((a, u) => a + u.min, 0);

  const totals = days.map(dayTotal);
  const totalMinutes = totals.reduce((a, b) => a + b, 0);
  const activeDays = totals.filter((t) => t > 0).length;

  const unknownAgg = new Map<string, { totalMin: number; days: number[] }>();
  for (const d of days) {
    for (const u of d.unknown || []) {
      const cur = unknownAgg.get(u.label) ?? { totalMin: 0, days: [] };
      cur.totalMin += u.min;
      cur.days.push(d.d);
      unknownAgg.set(u.label, cur);
    }
  }
  const unknownSubjects = Array.from(unknownAgg, ([label, v]) => ({ label, ...v }));

  return { totalDays: days.length, activeDays, totalMinutes, unknownSubjects };
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

function buildPayload(fetchedAt: number, days: ProgritDay[]) {
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
    master.days = applyManualDays(master.days);

    // 改名前パーサーで unknown 扱いのままKVに残っている分を補正する（冪等）。
    // 次のSlack差分取得（X-Cache: MISS）のタイミングで補正後の状態が永続化される。
    migrateRenamedSubjects(master.days);

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
