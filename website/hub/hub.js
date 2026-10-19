// ZYRON HUB: section navigation, two public status reads and a read-only Telegram web sign-in.
// No keys, no signing, no browser storage: the web session token lives only in this closure (memory) and is lost on reload.
// Remote data is written with textContent only and every field is type-checked before it is shown.
(() => {
  'use strict';
  const GAME_API = 'https://zyron-node.onrender.com';
  const GAME_META = `${GAME_API}/api/meta`;
  const RPC_STATUS = 'https://zyron-wallet-testnet-rpc.onrender.com/status';
  const TIMEOUT_MS = 60000; // free hosts can take up to a minute to wake

  const $ = (sel) => document.querySelector(sel);
  const sections = [...document.querySelectorAll('[data-section]')];
  const links = [...document.querySelectorAll('[data-nav]')];

  function show(id, focus) {
    const target = sections.find((s) => s.id === id) || sections[0];
    for (const s of sections) s.hidden = s !== target;
    for (const a of links) {
      if (a.dataset.nav === target.id) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    if (focus) { const h = target.querySelector('h1, h2'); if (h) { h.setAttribute('tabindex', '-1'); h.focus(); } }
  }
  document.documentElement.classList.add('hub-js');
  window.addEventListener('hashchange', () => show(location.hash.slice(1), true));
  show(location.hash.slice(1), false);

  function row(dt, dd, state) {
    const div = document.createElement('div'); div.className = 'hub-row';
    const t = document.createElement('dt'); t.textContent = dt;
    const d = document.createElement('dd');
    if (state) { const s = document.createElement('span'); s.className = `state state-${state}`; s.textContent = dd; d.append(s); } else d.textContent = dd;
    div.append(t, d); return div;
  }
  const put = (key, nodes) => { const el = $(`[data-out="${key}"]`); if (el) el.replaceChildren(...nodes); };
  const text = (key, value) => { const el = $(`[data-out="${key}"]`); if (el) el.textContent = value; };
  const str = (v, max = 120) => (typeof v === 'string' && v.length <= max ? v : null);
  const int = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);

  async function getJson(url, opts = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const headers = { Accept: 'application/json', ...(opts.headers || {}) };
      const init = { method: opts.method || 'GET', signal: ctrl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers };
      if (opts.body) { headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.body); }
      const res = await fetch(url, init);
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status}`);
        e.status = res.status;
        e.code = data && data.error && str(data.error.code, 40);
        e.userMessage = data && data.error && str(data.error.message, 200);
        throw e;
      }
      return data;
    } finally { clearTimeout(timer); }
  }

  async function loadGame() {
    text('overview-game', 'Game status: checking…');
    try {
      const m = await getJson(GAME_META);
      if (!m || m.name !== 'ZYRON NODE') throw new Error('unexpected response');
      const build = str(m.clientBuild, 40) || 'unknown';
      const season = m.season && str(m.season.name, 60);
      put('game-meta', [
        row('Game service', 'Online', 'ok'),
        row('Client build', build),
        row('Season', season || 'No active season'),
        row('Points', str(m.pointsNotice, 400) || 'Zyron Points are off-chain game points.')
      ]);
      text('overview-game', `Game status: online · build ${build}`);
    } catch (err) {
      put('game-meta', [row('Game service', 'Status not readable from this page', 'warn'),
        row('Why', 'The game service may be waking up, or it does not yet accept status reads from zyronchain.com. The game itself works in Telegram.')]);
      text('overview-game', 'Game status: not readable here right now. The game works in Telegram.');
    }
  }

  async function loadRpc() {
    text('overview-rpc', 'Testnet status: checking (a sleeping test service can take up to a minute)…');
    try {
      const s = await getJson(RPC_STATUS);
      if (!s || s.valueBearing !== false) throw new Error('refusing to show a status that does not declare valueBearing: false');
      const height = int(s.height);
      put('rpc-status', [
        row('Wallet testnet', 'Reachable', 'ok'),
        row('Value', 'None (valueBearing: false)', 'warn'),
        row('Chain ID', str(s.chainId, 80) || 'unknown'),
        row('Height', height === null ? 'unknown' : String(height)),
        row('Genesis hash', (str(s.genesisHash, 64) || 'unknown')),
        row('Notice', str(s.notice, 400) || 'Test ZYN has no value. Balances stay only when durable storage is on.')
      ]);
      text('overview-rpc', `Testnet status: reachable · height ${height === null ? 'unknown' : height} · no value`);
    } catch (err) {
      put('rpc-status', [row('Wallet testnet', 'Not reachable right now', 'warn'),
        row('Why', 'The free test service may be asleep or restarting. Try Refresh in a minute.')]);
      text('overview-rpc', 'Testnet status: not reachable right now (it may be waking up).');
    }
  }

  // ---- Read-only web sign-in (one-time code from @ZyronNodeBot) ----
  let session = null; // { token, expiresAt } in memory only
  let login = null;   // { loginId, secret, expiresAt } in memory only
  let tick = null;
  const BOT_LINK = /^https:\/\/t\.me\/ZyronNodeBot\?start=web_[0-9a-f]{32}$/;
  const q = (sel) => document.querySelector(sel);
  const setError = (msg) => { q('[data-signin-error]').textContent = msg || ''; };
  const num = (v) => (Number.isSafeInteger(v) ? String(v) : '-');

  function countdown() {
    clearInterval(tick);
    const el = q('[data-signin-timer]');
    const update = () => {
      if (!login) { el.textContent = ''; return; }
      const left = Math.max(0, Math.round((Date.parse(login.expiresAt) - Date.now()) / 1000));
      el.textContent = left > 0 ? `Open the bot within ${left} s. The code from the bot is then valid for 2 minutes.` : 'This sign-in request expired. If you already have a code, try it; otherwise start again.';
    };
    update();
    tick = setInterval(update, 1000);
  }

  async function signinStart() {
    setError('');
    try {
      const r = await getJson(`${GAME_API}/api/web/login/start`, { method: 'POST' });
      if (!r || !/^[0-9a-f]{32}$/.test(r.loginId || '') || !/^[0-9a-f]{64}$/.test(r.secret || '') || !BOT_LINK.test(r.botLink || '')) throw new Error('unexpected response');
      login = { loginId: r.loginId, secret: r.secret, expiresAt: str(r.expiresAt, 40) || new Date(Date.now() + 120000).toISOString() };
      q('[data-signin-link]').href = r.botLink;
      q('[data-signin-step]').hidden = false;
      countdown();
      q('[data-signin-link]').focus();
    } catch (e) {
      setError(e.status === 429 ? 'Too many sign-in attempts. Wait a few minutes.' : 'Sign-in is not reachable right now. The game service may be waking up; try again in a minute.');
    }
  }

  async function signinFinish() {
    setError('');
    if (!login) return setError('Press Sign in with Telegram first.');
    const code = q('#signin-code').value.replace(/[\s-]/g, '').toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) return setError('The code has 8 letters and digits, like ABCD-EFGH.');
    try {
      const r = await getJson(`${GAME_API}/api/web/login/finish`, { method: 'POST', body: { loginId: login.loginId, secret: login.secret, code } });
      if (!r || !/^[0-9a-f]{64}$/.test(r.token || '')) throw new Error('unexpected response');
      session = { token: r.token };
      login = null; clearInterval(tick);
      q('#signin-code').value = '';
      q('[data-signin-step]').hidden = true;
      await loadProfile();
    } catch (e) {
      if (e.code === 'login_used' || e.code === 'login_expired' || e.code === 'login_invalid') { login = null; q('[data-signin-step]').hidden = true; clearInterval(tick); }
      setError(e.userMessage || 'Sign-in failed. Start again.');
    }
  }

  function signedOut(message) {
    session = null;
    q('[data-profile]').hidden = true;
    q('[data-activity]').hidden = true;
    q('[data-activity-empty]').hidden = false;
    q('[data-signin]').hidden = false;
    if (message) setError(message);
  }

  async function loadProfile() {
    if (!session) return;
    let d;
    try {
      d = await getJson(`${GAME_API}/api/web/me`, { headers: { Authorization: `zws ${session.token}` } });
    } catch (e) {
      if (e.status === 401) return signedOut('Your web session ended. Sign in again.');
      if (e.code === 'no_player') return signedOut('Open ZYRON NODE in Telegram once to create your profile, then sign in again.');
      return setError('Could not load your progress. Try Refresh.');
    }
    if (!d || d.readOnly !== true) return setError('Unexpected response.');
    const p = d.profile || {}, pts = d.points || {}, en = d.energy || {}, w = d.wallet || {}, inv = d.invites || {};
    const tier = p.tier && typeof p.tier === 'object' ? str(p.tier.label, 30) : null;
    put('web-profile', [
      row('Player', str(p.displayName, 64) || 'Operator'),
      row('Level', num(p.level)),
      row('Tier', tier || 'Unranked'),
      row('Zyron Points', `${num(pts.balance)} (lifetime ${num(pts.lifetime)}) · off-chain, not ZYN`),
      row('Energy', `${num(en.current)} / ${num(en.max)}`),
      row('Node cycles', num(p.cycleCount)),
      row('Invites', `${num(inv.invited)} invited · ${num(inv.qualified)} qualified`),
      row('Wallet link', w.verified ? 'Verified (testnet)' : (w.linked ? 'Linked, not verified' : 'Not linked'), w.verified ? 'ok' : 'warn'),
      ...(p.teamAccount ? [row('Ranking', str(p.teamNote, 60) || 'Team account, not ranked')] : [])
    ]);
    put('web-upgrades', (Array.isArray(d.upgrades) ? d.upgrades.slice(0, 20) : []).map((u) => row(str(u.name, 30) || '-', `Level ${num(u.level)} / ${num(u.maxLevel)}`)));
    const rank = d.rank || {};
    put('web-rank', ['daily', 'weekly', 'season', 'alltime'].map((b) => {
      const r = rank[b] || {};
      return row(b === 'alltime' ? 'All-time' : b[0].toUpperCase() + b.slice(1), `${r.rank ? `#${num(r.rank)}` : 'Not ranked'} · ${num(r.score)} points`);
    }));
    const ach = d.achievements || {};
    put('web-achievements', [row('Unlocked', `${num(ach.unlocked)} of ${num(ach.total)}`),
      ...(Array.isArray(ach.items) ? ach.items.slice(0, 40) : []).map((a) => row(str(a.title, 60) || '-', a.unlocked ? 'Unlocked' : `${num(a.current)} / ${num(a.target)}`, a.unlocked ? 'ok' : null))]);
    q('[data-signin]').hidden = true;
    q('[data-profile]').hidden = false;
    q('[data-activity]').hidden = false;
    q('[data-activity-empty]').hidden = true;
  }

  async function signout() {
    const token = session && session.token;
    signedOut('');
    if (token) { try { await getJson(`${GAME_API}/api/web/logout`, { method: 'POST', headers: { Authorization: `zws ${token}` } }); } catch (_) { /* session is gone locally either way */ } }
  }

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'signin-start') signinStart();
    else if (act === 'signin-finish') signinFinish();
    else if (act === 'signin-refresh') loadProfile();
    else if (act === 'signout') signout();
  });
  const codeInput = q('#signin-code');
  if (codeInput) codeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') signinFinish(); });

  const refresh = () => { loadGame(); loadRpc(); if (session) loadProfile(); };
  let auto = null;
  document.addEventListener('click', (e) => { if (e.target.closest('[data-action="refresh"]')) refresh(); });
  const toggle = $('[data-setting="auto"]');
  if (toggle) toggle.addEventListener('change', () => { clearInterval(auto); auto = toggle.checked ? setInterval(refresh, 60000) : null; });
  refresh();
})();
