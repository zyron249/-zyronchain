// ZYRON HUB: section navigation plus two public, read-only status reads. No keys, no signing, no browser storage.
// Remote data is written with textContent only and every field is type-checked before it is shown.
(() => {
  'use strict';
  const GAME_META = 'https://zyron-node.onrender.com/api/meta';
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

  async function getJson(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
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
        row('Notice', str(s.notice, 400) || 'Test ZYN has no value and the network can reset.')
      ]);
      text('overview-rpc', `Testnet status: reachable · height ${height === null ? 'unknown' : height} · no value, may reset`);
    } catch (err) {
      put('rpc-status', [row('Wallet testnet', 'Not reachable right now', 'warn'),
        row('Why', 'The free test service may be asleep or restarting. Try Refresh in a minute.')]);
      text('overview-rpc', 'Testnet status: not reachable right now (it may be waking up).');
    }
  }

  const refresh = () => { loadGame(); loadRpc(); };
  let auto = null;
  document.addEventListener('click', (e) => { if (e.target.closest('[data-action="refresh"]')) refresh(); });
  const toggle = $('[data-setting="auto"]');
  if (toggle) toggle.addEventListener('change', () => { clearInterval(auto); auto = toggle.checked ? setInterval(refresh, 60000) : null; });
  refresh();
})();
