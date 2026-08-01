import fs from 'fs';

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = 'C08QDEH5H8V';
const WORKER = 'https://progrit-study-log-worker.ybrnc777.workers.dev/api/progrit';
const DOW_JP = ['日', '月', '火', '水', '木', '金', '土'];
const BASE_UTC = Date.UTC(2026, 3, 24);

function makeDay(d, s, sp, o, v, li, sc = 0, rp = 0) {
  const dt = new Date(BASE_UTC + (d - 1) * 86400000);
  const dowIdx = dt.getUTCDay();
  return {
    d,
    date: `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`,
    dow: DOW_JP[dowIdx],
    dowIdx,
    s, sp, o, v, li, sc, rp,
  };
}

function sumMin(text, subject) {
  const re = new RegExp(subject + '[^0-9]*?(\\d+)\\s*分', 'g');
  let total = 0;
  let m;
  while ((m = re.exec(text)) !== null) total += parseInt(m[1], 10);
  return total;
}

async function fetchAllSlack(token) {
  let messages = [];
  let cursor = '';
  do {
    const params = new URLSearchParams({ channel: CHANNEL, limit: '200', oldest: '0' });
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json();
    if (!data.ok) {
      console.error('slack error:', data.error);
      break;
    }
    messages = messages.concat(data.messages || []);
    cursor = data.response_metadata?.next_cursor ?? '';
  } while (cursor);
  return messages;
}

function parseProgritMessages(messages) {
  const headerRe = /プログリットで学習\s*(\d+)\s*日目/g;
  const dayMap = new Map();
  const ordered = [...messages].sort((a, b) => parseFloat(a.ts || '0') - parseFloat(b.ts || '0'));
  for (const msg of ordered) {
    const text = (msg.text || '').replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    );
    const heads = Array.from(text.matchAll(headerRe));
    for (let i = 0; i < heads.length; i++) {
      const day = parseInt(heads[i][1], 10);
      const start = (heads[i].index ?? 0) + heads[i][0].length;
      const end = i + 1 < heads.length ? (heads[i + 1].index ?? text.length) : text.length;
      const block = text.slice(start, end);
      const s = sumMin(block, 'シャドーイング');
      const sp = sumMin(block, '速読');
      const o = sumMin(block, '口頭英作文');
      const v = sumMin(block, '単語');
      const li = sumMin(block, '多聴');
      const sc = sumMin(block, 'スピーチ');
      const rp = sumMin(block, 'リピーティング');
      dayMap.set(day, makeDay(day, s, sp, o, v, li, sc, rp));
    }
  }
  return Array.from(dayMap.values()).sort((a, b) => a.d - b.d);
}

(async () => {
  if (!TOKEN) {
    console.error('SLACK_BOT_TOKEN not set');
    process.exit(1);
  }

  const current = await (await fetch(WORKER)).json();
  const seedMaxD = 42;
  const keepDays = current.days.filter((d) => d.d <= seedMaxD);
  console.log('kept days (<=42) from existing dataset:', keepDays.length);

  const messages = await fetchAllSlack(TOKEN);
  console.log('slack messages fetched:', messages.length);
  const parsed = parseProgritMessages(messages).filter((d) => d.d > seedMaxD);
  console.log('freshly parsed days (>42):', parsed.length, 'max day:', Math.max(...parsed.map((d) => d.d)));

  const rpDays = parsed.filter((d) => d.rp > 0);
  console.log('days with rp>0:', rpDays.map((d) => `Day${d.d}=${d.rp}分`));

  const merged = [...keepDays, ...parsed].sort((a, b) => a.d - b.d);
  console.log('merged total days:', merged.length, 'max day:', merged[merged.length - 1].d);

  const zeroDays = merged.filter((d) => d.s + d.sp + d.o + d.v + d.li + d.sc + d.rp === 0);
  console.log('zero-total days after merge:', zeroDays.map((d) => d.d));

  const master = { days: merged, lastMsgTs: '0', savedAt: Date.now() };
  fs.writeFileSync('master.json', JSON.stringify(master));
  console.log('wrote master.json');
})();
