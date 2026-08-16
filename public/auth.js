// アクセストークンの受け取り・保存・付与をまとめる。各ページはこれを読み込んで
// fetchWithToken(url) を使う。iframe の中でも単体で開いても同じように動く。
//
// スマホ対策として、URLに #token=... が付いていれば保存してURLから消す。
// これで「長いトークンを手打ちする」工程がリンク1回で済む。
(() => {
  const TOKEN_KEY = 'progritAppToken';
  const get = () => (localStorage.getItem(TOKEN_KEY) || '').trim();
  const save = (t) => localStorage.setItem(TOKEN_KEY, t);
  const clear = () => localStorage.removeItem(TOKEN_KEY);

  // URLからトークンを拾って保存し、アドレスバーと履歴からは消す
  function captureFromUrl() {
    const pick = (s) => new URLSearchParams(s.replace(/^[#?]/, '')).get('token');
    const t = (pick(location.hash) || pick(location.search) || '').trim();
    if (!t) return false;
    save(t);
    history.replaceState(null, '', location.pathname);
    return true;
  }
  captureFromUrl();

  // 開いたままの画面にリンクを貼られた場合、ハッシュだけの変化では
  // ページが再読み込みされない。拾ったうえで自分で読み直す。
  window.addEventListener('hashchange', () => { if (captureFromUrl()) location.reload(); });

  // 画面内の入力欄でトークンを聞く。window.prompt と違い、iframe内でも
  // ペーストしやすく、間違えてもやり直せる。
  function askToken(message) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0d1117;color:#e6edf3;' +
        'display:flex;align-items:center;justify-content:center;padding:24px;' +
        'font-family:system-ui,sans-serif';
      wrap.innerHTML =
        '<div style="width:100%;max-width:380px">' +
        '<div style="font-size:17px;font-weight:700;margin-bottom:8px">🔒 学習記録</div>' +
        '<div style="font-size:13px;line-height:1.7;color:#8b949e;margin-bottom:14px"></div>' +
        '<input type="text" inputmode="text" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
        'placeholder="progrit-…" style="width:100%;padding:13px 14px;border-radius:10px;' +
        'border:1.5px solid #30363d;background:#161b22;color:#e6edf3;font-size:16px">' +
        '<button style="width:100%;margin-top:10px;padding:14px;border:none;border-radius:10px;' +
        'background:#e5a93d;color:#15120d;font-size:15px;font-weight:700">開く</button>' +
        '</div>';
      wrap.querySelector('div > div:nth-child(2)').textContent = message;
      const input = wrap.querySelector('input');
      const button = wrap.querySelector('button');
      const done = () => {
        const v = input.value.trim();
        if (!v) return;
        wrap.remove();
        resolve(v);
      };
      button.addEventListener('click', done);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); });
      document.body.appendChild(wrap);
      input.focus();
    });
  }

  async function fetchWithToken(url) {
    let token = get();
    let res = await fetch(url, token ? { headers: { Authorization: 'Bearer ' + token } } : undefined);

    while (res.status === 401) {
      // 通らなかったトークンは保存し続けない。誤入力が焼き付いて
      // 毎回401になるのを防ぐ。
      clear();
      const entered = await askToken(
        token ? 'トークンが違うようです。入れ直してください。' : 'アクセストークンを入力してください。'
      );
      if (!entered) return res;
      res = await fetch(url, { headers: { Authorization: 'Bearer ' + entered } });
      if (res.ok) save(entered);
      token = entered;
    }
    return res;
  }

  window.fetchWithToken = fetchWithToken;
})();
