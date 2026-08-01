const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = 'C08QDEH5H8V';

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
  const known = ['シャドーイング', '速読', '口頭英作文', '単語', '多聴', 'スピーチ'];
  const knownRe = new RegExp(known.join('|'));
  const unknownLabels = new Map();
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
      const block = text.slice(start, end);
      dayBlocks.set(day, block);

      const labelRe = /([^\s0-9、。\n:：]{1,14})\s*[:：]?\s*(\d+)\s*分/g;
      let m;
      while ((m = labelRe.exec(block)) !== null) {
        const label = m[1].trim();
        if (label && !knownRe.test(label)) {
          unknownLabels.set(label, (unknownLabels.get(label) || 0) + 1);
        }
      }
    }
  }

  const days = [...dayBlocks.keys()].sort((a, b) => a - b);
  console.log('days with headers found:', days.length);
  console.log('day range:', days[0], '-', days[days.length - 1]);
  console.log('missing day numbers in range:', Array.from(
    { length: days[days.length - 1] - days[0] + 1 },
    (_, i) => days[0] + i,
  ).filter((d) => !dayBlocks.has(d)));

  console.log('\n=== unknown labels (not matching known 6 subjects) ===');
  if (unknownLabels.size === 0) console.log('(none found)');
  for (const [label, count] of unknownLabels) console.log(' -', JSON.stringify(label), 'x', count);

  console.log('\n=== zero-total days (all 6 known subjects = 0) ===');
  const zeroDays = [];
  for (const [d, block] of dayBlocks) {
    const s = sumMin(block, 'シャドーイング');
    const sp = sumMin(block, '速読');
    const o = sumMin(block, '口頭英作文');
    const v = sumMin(block, '単語');
    const li = sumMin(block, '多聴');
    const sc = sumMin(block, 'スピーチ');
    if (s + sp + o + v + li + sc === 0) zeroDays.push(d);
  }
  console.log(zeroDays.length ? zeroDays.sort((a, b) => a - b) : '(none)');

  console.log('\n=== raw blocks for day 55-75 (first 400 chars each) ===');
  for (let d = 55; d <= 75; d++) {
    if (dayBlocks.has(d)) {
      console.log(`--- Day ${d} ---`);
      console.log(dayBlocks.get(d).trim().slice(0, 400));
    }
  }
})();
