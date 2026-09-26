/* Boot recovery for the Mini App.
 * Transient /api/meta and /api/me failures retry with backoff.
 * No Telegram initData (and no dev id) stops at the gate and does not call /api/me.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronBoot = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var ATTEMPTS = 6;
  var TIMEOUT_MS = 8000;
  var FOLLOW_UP_LIMIT = 4;
  var FOLLOW_UP_MS = 8000;

  function retryDelayMs(failedAttempts) {
    var n = Number(failedAttempts) || 0;
    if (n <= 0) return 0;
    var delay = 800 * Math.pow(2, n - 1);
    if (delay > 5000) return 5000;
    return delay;
  }

  function isTransientFailure(error) {
    if (!error || typeof error !== "object") return true;
    if (error.code === "timeout" || error.code === "network" || error.name === "AbortError") return true;
    if (error.code === "bad_profile") return true;
    var status = Number(error.status) || 0;
    if (!status) return true;
    if (status === 408 || status === 429 || status >= 500) return true;
    return false;
  }

  function hasSessionAuth(initData, devId) {
    return !!(initData || devId);
  }

  function classifyMeta(meta, shell, build) {
    if (!meta || meta.shell !== shell || !meta.clientBuild) return "blocked";
    if (build && meta.clientBuild !== build) return "reload";
    return "continue";
  }

  function withRetry(run, options) {
    var attempts = Math.max(1, Number(options && options.attempts) || ATTEMPTS);
    var sleep = (options && options.sleep) || function (ms) {
      return new Promise(function (resolve) { setTimeout(resolve, ms); });
    };
    var onRetry = options && options.onRetry;
    var last = null;
    var i = 0;

    function step() {
      if (i >= attempts) {
        if (last && typeof last === "object") last.attempts = attempts;
        return Promise.reject(last || new Error("Request failed"));
      }
      var wait = i > 0 ? retryDelayMs(i) : 0;
      var pending = wait ? sleep(wait) : Promise.resolve();
      if (i > 0 && onRetry) onRetry(i);
      return pending.then(function () {
        return run(i);
      }).then(function (value) {
        return value;
      }, function (error) {
        last = error;
        if (last && typeof last === "object") last.attempts = i + 1;
        if (!isTransientFailure(last) || i === attempts - 1) throw last;
        i += 1;
        return step();
      });
    }

    return step();
  }

  function recoverBoot(env) {
    var attempts = env.attempts || ATTEMPTS;
    var retryOpts = { attempts: attempts, sleep: env.sleep, onRetry: env.onRetry };
    return withRetry(function () { return env.fetchMeta(); }, retryOpts).then(function (meta) {
      var kind = classifyMeta(meta, env.shell, env.build);
      if (kind === "blocked") return { phase: "blocked", meta: meta || null };
      if (kind === "reload") return { phase: "reload", meta: meta, build: meta.clientBuild };
      return Promise.resolve(env.ensureAuth()).then(function (authed) {
        if (env.onMeta) env.onMeta(meta);
        if (!authed) return { phase: "gate", meta: meta };
        return withRetry(function () { return env.fetchSession(); }, retryOpts).then(function (session) {
          return { phase: "ready", meta: meta, session: session };
        }, function (error) {
          return { phase: "error", error: error, meta: meta };
        });
      });
    }, function (error) {
      return { phase: "error", error: error, meta: null };
    });
  }

  return {
    ATTEMPTS: ATTEMPTS,
    TIMEOUT_MS: TIMEOUT_MS,
    FOLLOW_UP_LIMIT: FOLLOW_UP_LIMIT,
    FOLLOW_UP_MS: FOLLOW_UP_MS,
    retryDelayMs: retryDelayMs,
    isTransientFailure: isTransientFailure,
    hasSessionAuth: hasSessionAuth,
    classifyMeta: classifyMeta,
    withRetry: withRetry,
    recoverBoot: recoverBoot
  };
});
