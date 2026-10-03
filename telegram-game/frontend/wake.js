/* Wake-up handling for Play Zyron.
 * The page itself is served from an always-on static host, so it paints at once. The game API runs on a
 * free host that sleeps when idle and needs 30-60 s to start. This module pings the cheap /healthz
 * endpoint until the API answers, and reports a phase the UI can show:
 *   connecting -> (after SHOW_AFTER_MS without an answer) waking -> (after STALL_AFTER_MS) stalled -> ready
 * No game action is sent before the API is ready. Retries never stop on their own; the player can reload.
 */
(function (root, factory) {
  var api = factory();
  if (root) root.ZyronWake = api;
  if (typeof module === "object" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  var SHOW_AFTER_MS = 1200;
  var PING_TIMEOUT_MS = 12000;
  var RETRY_MS = 1500;
  var STALLED_RETRY_MS = 5000;
  var STALL_AFTER_MS = 120000;
  var TYPICAL_MS = 45000;

  function phaseFor(elapsedMs) {
    var t = Number(elapsedMs) || 0;
    if (t >= STALL_AFTER_MS) return "stalled";
    if (t >= SHOW_AFTER_MS) return "waking";
    return "connecting";
  }

  // Estimated progress for a typical cold start. It approaches but never reaches 100 % until the API answers.
  function progressFor(elapsedMs) {
    var t = Number(elapsedMs) || 0;
    if (t <= 0) return 0;
    var p = 1 - Math.exp(-t / (TYPICAL_MS / 2.3));
    return Math.min(0.95, p);
  }

  function isHealthy(payload) {
    return !!(payload && typeof payload === "object" && payload.ok === true);
  }

  /* env: {
   *   ping(timeoutMs) -> Promise<payload>  (rejects or resolves non-healthy while asleep),
   *   now() -> ms, sleep(ms) -> Promise, onAttempt(attempt, elapsedMs)?, cancelled() -> bool?
   * } resolves { phase: "ready" | "cancelled", attempts, elapsedMs } */
  function waitUntilAwake(env) {
    var now = env.now || function () { return Date.now(); };
    var sleep = env.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var started = now();
    var attempts = 0;

    function step() {
      if (env.cancelled && env.cancelled()) return Promise.resolve({ phase: "cancelled", attempts: attempts, elapsedMs: now() - started });
      attempts += 1;
      if (env.onAttempt) env.onAttempt(attempts, now() - started);
      return Promise.resolve()
        .then(function () { return env.ping(PING_TIMEOUT_MS); })
        .then(function (payload) { return isHealthy(payload); }, function () { return false; })
        .then(function (ok) {
          if (ok) return { phase: "ready", attempts: attempts, elapsedMs: now() - started };
          if (env.cancelled && env.cancelled()) return { phase: "cancelled", attempts: attempts, elapsedMs: now() - started };
          var wait = phaseFor(now() - started) === "stalled" ? STALLED_RETRY_MS : RETRY_MS;
          return sleep(wait).then(step);
        });
    }

    return step();
  }

  return {
    SHOW_AFTER_MS: SHOW_AFTER_MS,
    PING_TIMEOUT_MS: PING_TIMEOUT_MS,
    RETRY_MS: RETRY_MS,
    STALLED_RETRY_MS: STALLED_RETRY_MS,
    STALL_AFTER_MS: STALL_AFTER_MS,
    TYPICAL_MS: TYPICAL_MS,
    phaseFor: phaseFor,
    progressFor: progressFor,
    isHealthy: isHealthy,
    waitUntilAwake: waitUntilAwake
  };
});
