// Progressive open-testnet /readyz probe for the network-status section.
// No-value only: never claims mainnet or live trading. Safe when the free host is asleep.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZyronNetworkLive = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DEFAULT_GATEWAY = 'https://zyron-open-testnet.onrender.com';
  const FETCH_MS = 12_000;

  function sanitizeReasons(reasons) {
    if (!Array.isArray(reasons)) return [];
    return reasons
      .map((r) => String(r ?? '').trim())
      .filter((r) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(r))
      .slice(0, 12);
  }

  /** Summarize gateway /readyz JSON into UI copy. Never invents mainnet/trading claims. */
  function summarizeReadyz(body, httpOk) {
    if (!body || typeof body !== 'object') {
      return { kind: 'bad', state: 'Unreadable /readyz response', detail: 'Gateway returned unexpected JSON.' };
    }
    if (body.valueBearing === true) {
      return {
        kind: 'warn',
        state: 'Refusing to display readiness',
        detail: 'Gateway claimed valueBearing=true. This site will not treat that as live trading or mainnet.'
      };
    }
    if (body.network && body.network !== 'testnet') {
      return {
        kind: 'warn',
        state: 'Unexpected network label',
        detail: `Gateway network=${JSON.stringify(String(body.network).slice(0, 64))}; expected testnet.`
      };
    }
    const validators = Array.isArray(body.validators) ? body.validators : [];
    const up = validators.filter((v) => v && v.up);
    const notReady = up.filter((v) => v.ready === false).map((v) => String(v.name || 'validator'));
    const down = validators.filter((v) => v && v.up === false).map((v) => String(v.name || 'validator'));
    const height = Number.isFinite(body.maxHeight) ? body.maxHeight : null;
    const chainId = typeof body.chainId === 'string' ? body.chainId.slice(0, 80) : null;
    const quorum = Number.isFinite(body.quorum) ? body.quorum : null;
    const validatorsUp = Number.isFinite(body.validatorsUp) ? body.validatorsUp : up.length;
    const parts = [];
    if (chainId) parts.push(`chainId ${chainId}`);
    if (height !== null) parts.push(`height ${height}`);
    if (quorum !== null) parts.push(`validators up ${validatorsUp}/${quorum} quorum`);
    if (down.length) parts.push(`down: ${down.join(', ')}`);
    if (notReady.length) parts.push(`not ready: ${notReady.join(', ')}`);
    const nodeReasons = sanitizeReasons(body.reasons);
    if (nodeReasons.length) parts.push(`reasons: ${nodeReasons.join(', ')}`);
    parts.push('test ZYN has no value; mainnet is off; trading is not enabled');
    const ready = body.ok === true && httpOk;
    if (ready) {
      return { kind: 'ok', state: 'Ready (open testnet)', detail: parts.join(' · ') };
    }
    return {
      kind: 'degraded',
      state: 'Not ready',
      detail: parts.length ? parts.join(' · ') : 'Quorum not met or validators unhealthy.'
    };
  }

  function summarizeFetchError(err, timedOut) {
    if (timedOut) {
      return {
        kind: 'offline',
        state: 'Host asleep or unreachable',
        detail: 'Render free plan often sleeps when idle. First wake can take a minute; retry shortly. Still no mainnet.'
      };
    }
    const name = err && err.name ? String(err.name) : 'Error';
    return {
      kind: 'offline',
      state: 'Gateway unreachable',
      detail: `${name}: could not read /readyz. Free host may be waking or offline. Still no mainnet.`
    };
  }

  async function probe(gateway, fetchImpl, now) {
    const base = String(gateway || DEFAULT_GATEWAY).replace(/\/+$/, '');
    const fetchFn = fetchImpl || fetch;
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), FETCH_MS) : null;
    const started = typeof now === 'function' ? now() : Date.now();
    try {
      const res = await fetchFn(`${base}/readyz`, {
        method: 'GET',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        signal: ctrl ? ctrl.signal : undefined
      });
      let body = null;
      try { body = await res.json(); } catch { body = null; }
      return summarizeReadyz(body, res.ok);
    } catch (err) {
      const elapsed = (typeof now === 'function' ? now() : Date.now()) - started;
      const timedOut = (err && err.name === 'AbortError') || elapsed >= FETCH_MS - 50;
      return summarizeFetchError(err, timedOut);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function applySummary(root, summary) {
    if (!root || !summary) return;
    const stateEl = root.querySelector('[data-ns-live-state]');
    const detailEl = root.querySelector('[data-ns-live-detail]');
    root.dataset.nsLiveKind = summary.kind;
    if (stateEl) stateEl.textContent = summary.state;
    if (detailEl) detailEl.textContent = summary.detail || '';
  }

  async function refreshAll(options) {
    const opts = options || {};
    const roots = opts.roots || (typeof document !== 'undefined'
      ? [...document.querySelectorAll('[data-ns-live]')]
      : []);
    if (!roots.length) return;
    for (const root of roots) {
      applySummary(root, { kind: 'pending', state: 'Checking /readyz…', detail: 'Open no-value testnet only.' });
    }
    const summary = await probe(opts.gateway, opts.fetchImpl, opts.now);
    for (const root of roots) applySummary(root, summary);
    return summary;
  }

  function boot() {
    if (typeof document === 'undefined') return;
    const run = () => { refreshAll({ gateway: DEFAULT_GATEWAY }).catch(() => undefined); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });
    else run();
  }

  if (typeof document !== 'undefined') boot();

  return {
    DEFAULT_GATEWAY,
    FETCH_MS,
    sanitizeReasons,
    summarizeReadyz,
    summarizeFetchError,
    probe,
    applySummary,
    refreshAll
  };
});
