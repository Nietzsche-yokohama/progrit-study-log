// 学習ダッシュボード（KPI・グラフ・インサイト）の描画ロジック。
// progrit.html（全体）・progrit-cycle1.html（第一クール）・progrit-cycle2.html（第二クール）
// の3ページから共有される。各HTMLは読み込み前に DASHBOARD_CONFIG を定義する:
//   { title: 表示タイトル文字列, cycleKey: 'overall' | 'cycle1' | 'cycle2' }
// クールの境目（何日目まで）はWorker側(/api/progrit の cycles)が単一の情報源。
// このファイルやHTML側に日数を決め打ちしないことで、境目のズレによる
// 表示不一致の再発を防ぐ。

const WORKER = 'https://progrit-study-log-worker.ybrnc777.workers.dev/api/progrit';
const PAGE_VERSION = 'v2026.08.01c（クール別タブ対応）';

// Worker側がBearer認証必須になったため、初回にトークンを1度だけ入力して
// localStorageに保存する。401が返ったら（未入力 or トークン変更後）再入力を促す。
const TOKEN_KEY = 'progritAppToken';
async function fetchWithToken(url) {
  const saved = (localStorage.getItem(TOKEN_KEY) || '').trim();
  let res = await fetch(url, saved ? { headers: { Authorization: 'Bearer ' + saved } } : undefined);
  if (res.status === 401) {
    const entered = (window.prompt('アクセストークンを入力してください') || '').trim();
    if (!entered) return res;
    localStorage.setItem(TOKEN_KEY, entered);
    res = await fetch(url, { headers: { Authorization: 'Bearer ' + entered } });
  }
  return res;
}
const C = { shadow:'#4FC3F7', speed:'#81C784', oral:'#FFB74D', vocab:'#CE93D8', listen:'#F06292', speech:'#FFD54F', repeat:'#8BC34A' };
const DOW_NAMES = ['日','月','火','水','木','金','土'];

async function init() {
  try {
    const res = await fetchWithToken(WORKER);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data.days || data.days.length === 0) throw new Error('データなし');

    document.getElementById('pageTitle').textContent = '🎓 ' + DASHBOARD_CONFIG.title;
    document.title = DASHBOARD_CONFIG.title;

    const cycleKey = DASHBOARD_CONFIG.cycleKey || 'overall';
    let RAW = data.days;
    let summary = data.summary;
    let rangeNote = '';

    if (cycleKey !== 'overall') {
      const cyc = (data.cycles || []).find(c => c.key === cycleKey);
      if (!cyc) throw new Error('クール情報が見つかりません');
      RAW = data.days.filter(r => r.d >= cyc.fromDay && (cyc.toDay == null || r.d <= cyc.toDay));
      if (RAW.length === 0) throw new Error(`${cyc.label}のデータはまだありません（Day${cyc.fromDay}〜）`);
      summary = cyc;
      rangeNote = cyc.toDay == null
        ? `（Day${cyc.fromDay}〜現在）`
        : `（Day${cyc.fromDay}〜${cyc.toDay}）`;
    }

    render(RAW, data.fetchedAt, summary, rangeNote);
  } catch(e) {
    document.getElementById('loading').innerHTML =
      '<div class="error-txt">⚠ データ取得エラー<br><small>' + e.message + '</small></div>';
  }
}

function fmt(n) { return n.toLocaleString(); }

function render(RAW, fetchedAt, summary, rangeNote) {
  // ── 基本計算 ────────────────────────────────
  // 合計は必ずWorker側(summary.totalMinutes)を正とする。ページ内で独自に合計を
  // 再計算して画面間で数字が食い違う、という事態を構造的に防ぐため。
  const N = RAW.length;
  const totals = RAW.map(r => r.s + r.sp + r.o + r.v + r.li + (r.sc || 0) + (r.rp || 0));
  const localTotalMin = totals.reduce((a,b) => a+b, 0);
  const totalMin = summary ? summary.totalMinutes : localTotalMin;
  const totalHrs = (totalMin / 60).toFixed(1);
  const avgMin = (totalMin / N).toFixed(1);

  // ── 警告バナー：未知科目・サーバー側合計とのズレ検知 ──────
  const warnLines = [];
  if (summary && summary.unknownSubjects && summary.unknownSubjects.length > 0) {
    summary.unknownSubjects.forEach(u => {
      warnLines.push(`未対応の学習項目「${u.label}」を検出：合計${u.totalMin}分（${u.days.map(d=>'Day'+d).join(', ')}）。集計から漏れています。パーサーへの追加が必要です。`);
    });
  }
  if (summary && Math.abs(summary.totalMinutes - localTotalMin) > 0) {
    warnLines.push(`サーバー側の合計（${summary.totalMinutes}分）とこのページの再計算結果（${localTotalMin}分）が一致しません。表示ロジックにバグの可能性があります。`);
  }
  const warnBanner = document.getElementById('warnBanner');
  if (warnLines.length > 0) {
    warnBanner.style.display = 'block';
    warnBanner.innerHTML = '<strong>⚠ 要確認</strong><br>' + warnLines.join('<br>');
  } else {
    warnBanner.style.display = 'none';
  }
  const maxMin = Math.max(...totals);
  const minMin = Math.min(...totals);
  const maxDay = RAW[totals.indexOf(maxMin)];
  const minDay = RAW[totals.indexOf(minMin)];
  const sTotal  = RAW.reduce((a,r) => a+r.s,  0);
  const spTotal = RAW.reduce((a,r) => a+r.sp, 0);
  const oTotal  = RAW.reduce((a,r) => a+r.o,  0);
  const vTotal  = RAW.reduce((a,r) => a+r.v,  0);
  const liTotal = RAW.reduce((a,r) => a+r.li, 0);
  const scTotal = RAW.reduce((a,r) => a+(r.sc||0), 0);
  const rpTotal = RAW.reduce((a,r) => a+(r.rp||0), 0);

  const labels = RAW.map(r => `Day${r.d}\n${r.date}(${r.dow})`);
  const shortLabels = RAW.map(r => r.date);

  // ── サブタイトル ──────────────────────────────
  const firstDate = RAW[0].date; const firstDow = RAW[0].dow;
  const lastDate  = RAW[N-1].date; const lastDow = RAW[N-1].dow;
  document.getElementById('subtitle').innerHTML =
    `${firstDate}（${firstDow}） 〜 ${lastDate}（${lastDow}）` +
    `<span class="badge">${N}日間${rangeNote}</span><span class="badge">よこはま（横浜一輝）</span>`;

  // ── KPI ─────────────────────────────────────
  const subjectCount = [sTotal,spTotal,oTotal,vTotal,liTotal,scTotal,rpTotal].filter(v=>v>0).length;
  const zeroDaysForKpi = totals.filter(t => t === 0).length;
  document.getElementById('kpiGrid').innerHTML = `
    <div class="kpi hl"><div class="val" style="color:#58a6ff">${totalHrs}</div><div class="lbl">総学習時間（時間）</div><div class="sub">${fmt(totalMin)} 分</div></div>
    <div class="kpi"><div class="val">${avgMin}</div><div class="lbl">日平均（分）</div><div class="sub">${Math.floor(avgMin/60)}時間 ${Math.round(avgMin%60)}分</div></div>
    <div class="kpi hl"><div class="val" style="color:#81C784">${N}</div><div class="lbl">対象日数</div><div class="sub">${zeroDaysForKpi === 0 ? '🔥 皆勤継続中' : `記録なし${zeroDaysForKpi}日`}</div></div>
    <div class="kpi"><div class="val">${maxMin}</div><div class="lbl">最高記録（分）</div><div class="sub">${maxDay.date}（${maxDay.dow}）Day${maxDay.d}</div></div>
    <div class="kpi"><div class="val" style="color:#F06292">${minMin}</div><div class="lbl">最低記録（分）</div><div class="sub">${minDay.date}（${minDay.dow}）Day${minDay.d}</div></div>
    <div class="kpi"><div class="val">${subjectCount}</div><div class="lbl">学習科目数</div><div class="sub">${rpTotal>0?'最新: リピーティング 追加':(scTotal>0?'最新: 1分間スピーチ 追加':(liTotal>0?'最新: 多聴 追加':''))}</div></div>
  `;

  // ── 科目リスト ────────────────────────────────
  const subjData = [
    {name:'シャドーイング', val:sTotal,  color:C.shadow},
    {name:'速読',          val:spTotal, color:C.speed},
    {name:'単語',          val:vTotal,  color:C.vocab},
    {name:'口頭英作文',    val:oTotal,  color:C.oral},
    {name:'多聴',          val:liTotal, color:C.listen},
    {name:'1分間スピーチ', val:scTotal, color:C.speech},
    {name:'リピーティング', val:rpTotal, color:C.repeat},
  ].filter(s => s.val > 0).sort((a,b) => b.val - a.val);
  const maxSubj = subjData[0]?.val || 1;
  document.getElementById('subjList').innerHTML = subjData.map(s =>
    `<div class="subj-row">
      <span class="subj-name" style="color:${s.color}">${s.name}</span>
      <div class="bar-wrap"><div class="bar-fill" style="width:${(s.val/maxSubj*100).toFixed(1)}%;background:${s.color}"></div></div>
      <span class="subj-mins">${fmt(s.val)}分</span>
    </div>`
  ).join('');

  // ── 曜日別 ───────────────────────────────────
  const dowGroups = Array.from({length:7}, () => ({sum:0, n:0}));
  RAW.forEach(r => {
    const tot = r.s + r.sp + r.o + r.v + r.li + (r.sc || 0) + (r.rp || 0);
    dowGroups[r.dowIdx].sum += tot;
    dowGroups[r.dowIdx].n++;
  });
  const dowAvgs = dowGroups.map(g => g.n ? Math.round(g.sum/g.n) : 0);
  const dowNs   = dowGroups.map(g => g.n);
  const maxDow  = Math.max(...dowAvgs);
  // 月〜日の順で表示 (1,2,3,4,5,6,0)
  const dowOrder = [1,2,3,4,5,6,0];
  document.getElementById('dowGrid').innerHTML = dowOrder.map(i => {
    const isHi = dowAvgs[i] >= maxDow * 0.85 && dowNs[i] > 0;
    return `<div class="dow-cell${isHi?' hi':''}">
      <div class="day">${DOW_NAMES[i]}</div>
      <div class="avg"${isHi?' style="color:#58a6ff"':''}>${dowNs[i]?dowAvgs[i]:'-'}</div>
      <div class="n">${dowNs[i]}日</div>
    </div>`;
  }).join('');

  // ── インサイト ────────────────────────────────
  // 学習優先順位: ①シャドーイング ②単語・英作文 ③速読・多聴
  // 「今こうなっているんだ」と気づけて、かつモチベーションが上がる内容にする。
  const insights = [];
  const pct = v => totalMin ? Math.round(v / totalMin * 100) : 0;
  const recentN = Math.min(7, N);
  const recentAvg = Math.round(RAW.slice(-recentN).reduce((a,r)=>a+r.s+r.sp+r.o+r.v+r.li+(r.sc||0)+(r.rp||0),0) / recentN);
  const overallAvg = Math.round(totalMin / N);

  // 1. 継続の称賛（モチベの土台）※ 実際に0分の日がないかを必ず確認してから断定する
  const zeroDays = RAW.filter((r, i) => totals[i] === 0);
  const activeDays = N - zeroDays.length;
  if (zeroDays.length === 0) {
    insights.push({type:'good', icon:'🔥', html:
      `<strong>${N}日連続、1日も休んでいません。</strong>　${firstDate}〜${lastDate}で総学習 <strong>${totalHrs}時間</strong>。これは才能ではなく“続けられる人”である証拠。積み上げた時間は必ずスコアに返ってきます。`});
  } else {
    const restList = zeroDays.map(r => `Day${r.d}(${r.date})`).join('・');
    insights.push({type:'', icon:'🔥', html:
      `<strong>${N}日間で記録できたのは${activeDays}日。</strong>　${firstDate}〜${lastDate}で総学習 <strong>${totalHrs}時間</strong>。記録が無い日は ${restList} の${zeroDays.length}日。完璧である必要はないので、次の1日を空けないことだけ意識しましょう。`});
  }

  // 2. 直近の勢い（維持 or 立て直し）
  if (recentAvg >= overallAvg) {
    insights.push({type:'good', icon:'📈', html:
      `<strong>いま勢いが乗っています。</strong>　直近${recentN}日の平均は <strong>${recentAvg}分/日</strong>で全期間平均 ${overallAvg}分を上回るペース。今の生活リズムが“勝ちパターン”。このまま崩さず維持しましょう。`});
  } else {
    insights.push({type:'warn', icon:'📈', html:
      `<strong>少しペースダウン中。気づけたら大丈夫。</strong>　直近${recentN}日は平均 <strong>${recentAvg}分/日</strong>（全期間平均 ${overallAvg}分）。まずは“最優先のシャドーイングだけは毎日やる”に絞ると立て直しやすいです。`});
  }

  // 3. 最優先＝シャドーイング
  const sShare = pct(sTotal);
  const topIsShadow = sTotal >= Math.max(spTotal, oTotal, vTotal, liTotal, scTotal, rpTotal);
  if (topIsShadow) {
    insights.push({type:'good', icon:'🎙️', html:
      `<strong>最優先のシャドーイングが土台になっています。</strong>　全体の <strong>${sShare}%</strong>（${fmt(sTotal)}分）で全科目中もっとも多く、優先順位どおりに時間を使えています。発音と音声知覚の伸びはここで決まる——いい配分です。`});
  } else {
    insights.push({type:'warn', icon:'🎙️', html:
      `<strong>シャドーイングをもう一押し。</strong>　最優先科目ですが現在 ${sShare}%（${fmt(sTotal)}分）。1日10分の上乗せでも、リスニングとスピーキングの伸びが一気に加速します。ここが最重要です。`});
  }

  // 4. 優先②＝単語・英作文（インプット→アウトプットの連結）
  const p2 = vTotal + oTotal;
  insights.push({type:'', icon:'✍️', html:
    `<strong>単語＆英作文も着実に積み上がり。</strong>　優先②の2科目で合計 <strong>${fmt(p2)}分</strong>（単語 ${fmt(vTotal)}分／口頭英作文 ${fmt(oTotal)}分）。覚えた単語を英作文ですぐ使うと、“知っている”が“使える”に変わります。`});

  // 5. 単語のムラ（強みを認めつつ安定化を促す）
  const vocabs = RAW.map(r => r.v);
  const vocabMax = Math.max(...vocabs), vocabMin = Math.min(...vocabs);
  if (vocabMax - vocabMin > 60) {
    const peakDay = RAW[vocabs.indexOf(vocabMax)];
    insights.push({type:'', icon:'🎯', html:
      `<strong>単語は“ムラ”を減らすと一気に伸びます。</strong>　Day${peakDay.d}に ${vocabMax}分やり切れる集中力は大きな武器。あとは0分の日を作らず毎日15〜20分を死守できれば、記憶の定着率が確実に上がります。`});
  }

  // 6. 優先③＝速読・多聴（“ほどよく”でOKという安心材料）
  const p3 = spTotal + liTotal;
  const firstLiDay = RAW.find(r => r.li > 0);
  if (p3 > 0) {
    const liNote = firstLiDay ? `Day${firstLiDay.d}から多聴も加わり、` : '';
    insights.push({type:'good', icon:'🎧', html:
      `<strong>インプットの幅も広がっています。</strong>　${liNote}速読＋多聴で全体の ${pct(p3)}%。優先③らしく“やり過ぎず・切らさず”の配分ができています。耳と速読の土台づくりは順調です。`});
  }

  // 7. 教材レベルの進化（固定・モチベ）
  if (sTotal > 0) {
    insights.push({type:'', icon:'📖', html:
      `<strong>扱う教材が着実にレベルアップ。</strong>　英検®→Keisuke Honda→CosmoPier と難易度が上がっても継続できているのは、実力が付いてきた証拠。「少し難しい」と感じる今が、一番伸びている瞬間です。`});
  }

  document.getElementById('insightList').innerHTML = insights.map(ins =>
    `<div class="insight${ins.type?' '+ins.type:''}">
      <span class="icon">${ins.icon}</span>
      <span class="txt">${ins.html}</span>
    </div>`
  ).join('');

  // ── フッター ─────────────────────────────────
  const updatedStr = fetchedAt
    ? new Date(fetchedAt).toLocaleString('ja-JP', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})
    : '—';
  document.getElementById('footer').textContent =
    `${DASHBOARD_CONFIG.title} ${PAGE_VERSION} ｜ データソース: Slack #課外活動_罰金英会話 ｜ 最終更新: ${updatedStr}`;

  // ── Chart.js ─────────────────────────────────
  const gridColor = '#21262d';

  // 1. Daily bar
  new Chart(document.getElementById('dailyChart'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: '合計（分）', data: totals,
        backgroundColor: totals.map(v => v >= 200 ? '#58a6ff' : v >= 120 ? '#4FC3F766' : '#30363d'),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ` ${ctx.parsed.y}分` } } },
      scales: {
        x: { grid: { color: gridColor }, ticks: { font: { size: 8 }, maxRotation: 90, autoSkip: true, maxTicksLimit: 20 } },
        y: { grid: { color: gridColor }, ticks: { callback: v => `${v}分` } }
      }
    }
  });

  // 2. Donut
  const subjTotals = [sTotal, spTotal, oTotal, vTotal, liTotal, scTotal, rpTotal];
  const donutData = subjTotals.filter(v => v > 0);
  const donutLabels = ['シャドーイング','速読','口頭英作文','単語','多聴','1分間スピーチ','リピーティング'].filter((_,i) => subjTotals[i] > 0);
  const donutColors = [C.shadow, C.speed, C.oral, C.vocab, C.listen, C.speech, C.repeat].filter((_,i) => subjTotals[i] > 0);
  new Chart(document.getElementById('donutChart'), {
    type: 'doughnut',
    data: { labels: donutLabels, datasets: [{ data: donutData, backgroundColor: donutColors, borderWidth: 0 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 }, color: '#8b949e' } } }
    }
  });

  // 3. Stacked bar
  new Chart(document.getElementById('stackedChart'), {
    type: 'bar',
    data: {
      labels: shortLabels,
      datasets: [
        { label: 'シャドーイング', data: RAW.map(r=>r.s),  backgroundColor: C.shadow,  stack: 'a' },
        { label: '速読',          data: RAW.map(r=>r.sp), backgroundColor: C.speed,   stack: 'a' },
        { label: '口頭英作文',    data: RAW.map(r=>r.o),  backgroundColor: C.oral,    stack: 'a' },
        { label: '単語',          data: RAW.map(r=>r.v),  backgroundColor: C.vocab,   stack: 'a' },
        { label: '多聴',          data: RAW.map(r=>r.li), backgroundColor: C.listen,  stack: 'a' },
        { label: '1分間スピーチ', data: RAW.map(r=>r.sc||0), backgroundColor: C.speech,  stack: 'a' },
        { label: 'リピーティング', data: RAW.map(r=>r.rp||0), backgroundColor: C.repeat,  stack: 'a' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { stacked: true, grid: { color: gridColor }, ticks: { font: { size: 8 }, maxRotation: 45, autoSkip: true, maxTicksLimit: 15 } },
        y: { stacked: true, grid: { color: gridColor }, ticks: { callback: v => `${v}分` } }
      }
    }
  });

  // 4. DOW bar (月〜日)
  new Chart(document.getElementById('dowChart'), {
    type: 'bar',
    data: {
      labels: dowOrder.map(i => DOW_NAMES[i]),
      datasets: [{
        label: '平均（分）',
        data: dowOrder.map(i => dowAvgs[i]),
        backgroundColor: dowOrder.map(i =>
          dowAvgs[i] >= maxDow * 0.85 ? '#58a6ff' : '#30363d'
        ),
        borderRadius: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridColor } },
        y: { grid: { color: gridColor }, ticks: { callback: v => `${v}分` } }
      }
    }
  });

  // 6. Trend (7-day moving avg)
  function movAvg(arr, n=7) {
    return arr.map((_,i) => {
      const slice = arr.slice(Math.max(0,i-n+1), i+1);
      return +(slice.reduce((a,b) => a+b, 0) / slice.length).toFixed(1);
    });
  }
  new Chart(document.getElementById('trendChart'), {
    type: 'line',
    data: {
      labels: shortLabels,
      datasets: [
        { label:'シャドーイング', data:movAvg(RAW.map(r=>r.s)),  borderColor:C.shadow, backgroundColor:'transparent', tension:0.4, pointRadius:0, borderWidth:2 },
        { label:'速読',          data:movAvg(RAW.map(r=>r.sp)), borderColor:C.speed,  backgroundColor:'transparent', tension:0.4, pointRadius:0, borderWidth:2 },
        { label:'口頭英作文',    data:movAvg(RAW.map(r=>r.o)),  borderColor:C.oral,   backgroundColor:'transparent', tension:0.4, pointRadius:0, borderWidth:2 },
        { label:'単語',          data:movAvg(RAW.map(r=>r.v)),  borderColor:C.vocab,  backgroundColor:'transparent', tension:0.4, pointRadius:0, borderWidth:2 },
        { label:'1分間スピーチ', data:movAvg(RAW.map(r=>r.sc||0)), borderColor:C.speech, backgroundColor:'transparent', tension:0.4, pointRadius:0, borderWidth:2 },
        { label:'リピーティング', data:movAvg(RAW.map(r=>r.rp||0)), borderColor:C.repeat, backgroundColor:'transparent', tension:0.4, pointRadius:0, borderWidth:2 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position:'bottom', labels: { boxWidth:10, font: { size:10 }, color:'#8b949e' } } },
      scales: {
        x: { grid: { color: gridColor }, ticks: { font: { size:9 }, maxRotation:45, autoSkip:true, maxTicksLimit:15 } },
        y: { grid: { color: gridColor }, ticks: { callback: v => `${v}分` } }
      }
    }
  });

  // ── 表示 ──────────────────────────────────────
  document.getElementById('loading').style.display = 'none';
  document.getElementById('main').style.display = 'block';
}

init();
