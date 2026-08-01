const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = 'C08QDEH5H8V';
const WORKER = 'https://progrit-study-log-worker.ybrnc777.workers.dev/api/progrit';

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

function sumMin(text, subject) {
  const re = new RegExp(subject + '[^0-9]*?(\\d+)\\s*分', 'g');
  let total = 0;
  let m;
  while ((m = re.exec(text)) !== null) total += parseInt(m[1], 10);
  return total;
}

(async () => {
  if (!TOKEN) {
    console.error('SLACK_BOT_TOKEN not set');
    process.exit(1);
  }
  const messages = await fetchAllSlack(TOKEN);
  console.log('total messages fetched:', messages.length);

  const headerRe = /プログリットで学習\s*(\d+)\s*日目/g;
  const dayBlocks = new Map();

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
      dayBlocks.set(day, text.slice(start, end));
    }
  }

  console.log('\n=== full-text search for "リピーティング" across all days ===');
  for (const [d, block] of [...dayBlocks].sort((a, b) => a[0] - b[0])) {
    const re = /リピーティング[^0-9]*?(\d+)\s*分/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      console.log(`Day ${d}: リピーティング ${m[1]}分`);
    }
  }

  console.log('\n=== raw blocks for zero-total days (61, 89, 92) ===');
  for (const d of [61, 89, 92]) {
    console.log(`--- Day ${d} ---`);
    console.log(JSON.stringify(dayBlocks.get(d) ?? '(no block found in current Slack retention)'));
  }

  console.log('\n=== cross-check against currently deployed worker data ===');
  try {
    const res = await fetch(WORKER);
    const data = await res.json();
    const byDay = new Map(data.days.map((r) => [r.d, r]));
    for (const d of [61, 89, 92]) {
      const r = byDay.get(d);
      console.log(`Day ${d} in deployed KV:`, r ? JSON.stringify(r) : '(missing)');
    }

    console.log('\n=== recompute insight-relevant stats over full deployed dataset ===');
    const RAW = data.days;
    const N = RAW.length;
    const totals = RAW.map((r) => r.s + r.sp + r.o + r.v + r.li + (r.sc || 0));
    const zeroDays = RAW.filter((r, i) => totals[i] === 0).map((r) => r.d);
    console.log('N (total days in dataset):', N);
    console.log('zero-total days in full dataset:', zeroDays.length ? zeroDays : '(none)');
    console.log('"N日連続、1日も休んでいません" claim holds:', zeroDays.length === 0);

    const sTotal = RAW.reduce((a, r) => a + r.s, 0);
    const spTotal = RAW.reduce((a, r) => a + r.sp, 0);
    const oTotal = RAW.reduce((a, r) => a + r.o, 0);
    const vTotal = RAW.reduce((a, r) => a + r.v, 0);
    const liTotal = RAW.reduce((a, r) => a + r.li, 0);
    const scTotal = RAW.reduce((a, r) => a + (r.sc || 0), 0);
    console.log('subject totals (min): shadow', sTotal, 'speed', spTotal, 'oral', oTotal, 'vocab', vTotal, 'listen', liTotal, 'speech', scTotal);
    const topIsShadow = sTotal >= Math.max(spTotal, oTotal, vTotal, liTotal, scTotal);
    console.log('topIsShadow (shadowing is #1 subject):', topIsShadow, '-> actual #1 is', ['shadow','speed','oral','vocab','listen','speech'][[sTotal,spTotal,oTotal,vTotal,liTotal,scTotal].indexOf(Math.max(sTotal,spTotal,oTotal,vTotal,liTotal,scTotal))]);

    const recentN = Math.min(7, N);
    const recentAvg = Math.round(RAW.slice(-recentN).reduce((a, r) => a + r.s + r.sp + r.o + r.v + r.li + (r.sc || 0), 0) / recentN);
    const overallAvg = Math.round(totals.reduce((a, b) => a + b, 0) / N);
    console.log('recentAvg (last 7d):', recentAvg, 'overallAvg:', overallAvg, '-> pace insight:', recentAvg >= overallAvg ? 'good/勢いあり' : 'warn/ペースダウン');

    const vocabs = RAW.map((r) => r.v);
    const vocabMax = Math.max(...vocabs), vocabMin = Math.min(...vocabs);
    console.log('vocab max/min:', vocabMax, vocabMin, 'spread>60:', vocabMax - vocabMin > 60);
  } catch (e) {
    console.error('worker fetch failed:', e.message);
  }
})();
