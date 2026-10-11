const assert = require("assert");
const wake = require("../frontend/wake.js");
const boot = require("../frontend/boot-recover.js");

(async function () {
  // Phases: a fast answer never flashes the waking screen; a slow one shows it; a very slow one stalls.
  assert.strictEqual(wake.phaseFor(0), "connecting");
  assert.strictEqual(wake.phaseFor(wake.SHOW_AFTER_MS - 1), "connecting");
  assert.strictEqual(wake.phaseFor(wake.SHOW_AFTER_MS), "waking");
  assert.strictEqual(wake.phaseFor(wake.STALL_AFTER_MS), "stalled");
  assert.ok(wake.SHOW_AFTER_MS >= 500 && wake.SHOW_AFTER_MS <= 3000);
  assert.ok(wake.STALL_AFTER_MS >= 60000);
  // Progress grows, stays below 100 % until the API answers.
  let last = -1;
  for (let t = 0; t <= 300000; t += 5000) {
    const p = wake.progressFor(t);
    assert.ok(p >= last && p <= 0.95, "monotonic, capped");
    last = p;
  }
  assert.ok(wake.progressFor(45000) > 0.8, "typical cold start is near the end of the bar");
  assert.strictEqual(wake.isHealthy({ ok: true, service: "zyron-node" }), true);
  assert.strictEqual(wake.isHealthy({ ok: false }), false);
  assert.strictEqual(wake.isHealthy("<html>Service waking up</html>"), false, "an HTML interstitial is not healthy");
  assert.strictEqual(wake.isHealthy(null), false);

  // Simulated cold start: network errors, a proxy page and a 5xx, then healthy. Only /healthz is called.
  let clock = 0;
  const calls = [];
  const answers = [
    () => Promise.reject(new TypeError("Failed to fetch")),
    () => Promise.resolve("<html>waking</html>"),
    () => Promise.resolve(null),
    () => Promise.resolve({ ok: true })
  ];
  const attempts = [];
  const outcome = await wake.waitUntilAwake({
    now: () => clock,
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
    onAttempt: (n) => attempts.push(n),
    ping: (timeoutMs) => { calls.push(timeoutMs); clock += 2000; return answers[calls.length - 1](); }
  });
  assert.strictEqual(outcome.phase, "ready");
  assert.strictEqual(outcome.attempts, 4);
  assert.deepStrictEqual(attempts, [1, 2, 3, 4]);
  assert.ok(calls.every((t) => t === wake.PING_TIMEOUT_MS));

  // After the stall threshold it keeps retrying, more slowly, and never gives up on its own.
  clock = 0;
  let n = 0;
  const sleeps = [];
  const slow = await wake.waitUntilAwake({
    now: () => clock,
    sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    ping: () => { n += 1; clock += wake.PING_TIMEOUT_MS; return n < 20 ? Promise.reject(new Error("timeout")) : Promise.resolve({ ok: true }); }
  });
  assert.strictEqual(slow.phase, "ready");
  assert.ok(sleeps.includes(wake.RETRY_MS) && sleeps.includes(wake.STALLED_RETRY_MS));

  // Cancellation (a newer boot started) stops the loop.
  let stop = false;
  const cancelled = await wake.waitUntilAwake({
    now: () => 0,
    sleep: () => { stop = true; return Promise.resolve(); },
    cancelled: () => stop,
    ping: () => Promise.reject(new Error("down"))
  });
  assert.strictEqual(cancelled.phase, "cancelled");

  // Decoupled shell: a different API build is fine, a different shell id means "API is updating", never a reload loop.
  assert.strictEqual(boot.classifyMeta({ shell: "s", clientBuild: "new" }, "s", "old", true), "continue");
  assert.strictEqual(boot.classifyMeta({ shell: "other", clientBuild: "x" }, "s", "old", true), "updating");
  assert.strictEqual(boot.classifyMeta(null, "s", "old", true), "blocked");
  assert.strictEqual(boot.classifyMeta({ shell: "s", clientBuild: "new" }, "s", "old", false), "reload");
  const updating = await boot.recoverBoot({
    shell: "s", build: "b", decoupled: true, attempts: 1,
    sleep: () => Promise.resolve(),
    fetchMeta: () => Promise.resolve({ shell: "next", clientBuild: "c" }),
    ensureAuth: () => { throw new Error("must not authenticate against a mismatched API"); },
    fetchSession: () => { throw new Error("must not load a session against a mismatched API"); }
  });
  assert.strictEqual(updating.phase, "updating");

  console.log("wake ok");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
