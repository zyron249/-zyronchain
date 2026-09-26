const assert = require("assert");
const boot = require("../frontend/boot-recover.js");

function immediate() {
  return Promise.resolve();
}

function fail(status, code) {
  const error = new Error(code || "failed");
  if (status) error.status = status;
  if (code) error.code = code;
  return error;
}

(async function () {
  assert.strictEqual(boot.retryDelayMs(0), 0);
  assert.strictEqual(boot.retryDelayMs(1), 800);
  assert.strictEqual(boot.retryDelayMs(2), 1600);
  assert.strictEqual(boot.retryDelayMs(3), 3200);
  assert.strictEqual(boot.retryDelayMs(4), 5000);
  assert.strictEqual(boot.retryDelayMs(8), 5000);
  assert.ok(boot.ATTEMPTS >= 4 && boot.ATTEMPTS <= 8);
  assert.ok(boot.FOLLOW_UP_LIMIT >= 1 && boot.FOLLOW_UP_LIMIT <= 6);
  assert.ok(boot.TIMEOUT_MS >= 3000 && boot.TIMEOUT_MS <= 20000);

  assert.strictEqual(boot.isTransientFailure({ status: 500 }), true);
  assert.strictEqual(boot.isTransientFailure({ status: 502 }), true);
  assert.strictEqual(boot.isTransientFailure({ status: 503 }), true);
  assert.strictEqual(boot.isTransientFailure({ status: 429 }), true);
  assert.strictEqual(boot.isTransientFailure({ status: 408 }), true);
  assert.strictEqual(boot.isTransientFailure({ code: "timeout" }), true);
  assert.strictEqual(boot.isTransientFailure({ code: "network" }), true);
  assert.strictEqual(boot.isTransientFailure({ name: "AbortError" }), true);
  assert.strictEqual(boot.isTransientFailure({ code: "bad_profile" }), true);
  assert.strictEqual(boot.isTransientFailure({ status: 401 }), false);
  assert.strictEqual(boot.isTransientFailure({ status: 403 }), false);
  assert.strictEqual(boot.isTransientFailure({ status: 400 }), false);
  assert.strictEqual(boot.isTransientFailure({ status: 409 }), false);
  assert.strictEqual(boot.hasSessionAuth("", ""), false);
  assert.strictEqual(boot.hasSessionAuth("init", ""), true);
  assert.strictEqual(boot.hasSessionAuth("", "dev"), true);

  const delays = [];
  await boot.withRetry(async function () {
    throw fail(500);
  }, {
    attempts: 3,
    sleep: async function (ms) { delays.push(ms); }
  }).then(function () { throw new Error("withRetry should reject"); }, function (error) {
    assert.strictEqual(error.status, 500);
    assert.strictEqual(error.attempts, 3);
  });
  assert.deepStrictEqual(delays, [800, 1600]);

  let metaCalls = 0;
  let sessionCalls = 0;
  const retries = [];
  let sawMeta = false;
  const healed = await boot.recoverBoot({
    shell: "tiers-ledger",
    build: "20260926.1",
    attempts: 6,
    sleep: immediate,
    onRetry: function (n) { retries.push(n); },
    onMeta: function (meta) {
      sawMeta = meta.clientBuild === "20260926.1";
    },
    fetchMeta: async function () {
      metaCalls += 1;
      if (metaCalls < 3) throw fail(500);
      return { shell: "tiers-ledger", clientBuild: "20260926.1", name: "ZYRON NODE" };
    },
    ensureAuth: async function () { return true; },
    fetchSession: async function () {
      sessionCalls += 1;
      if (sessionCalls === 1) throw fail(503);
      return { player: { id: 1 } };
    }
  });
  assert.strictEqual(healed.phase, "ready");
  assert.strictEqual(metaCalls, 3);
  assert.strictEqual(sessionCalls, 2);
  assert.strictEqual(sawMeta, true);
  assert.deepStrictEqual(retries, [1, 2, 1]);

  let deadMeta = 0;
  let deadSession = 0;
  const dead = await boot.recoverBoot({
    shell: "tiers-ledger",
    build: "20260926.1",
    attempts: 4,
    sleep: immediate,
    fetchMeta: async function () {
      deadMeta += 1;
      throw fail(0, "timeout");
    },
    ensureAuth: async function () { throw new Error("auth should not run"); },
    fetchSession: async function () {
      deadSession += 1;
      return {};
    }
  });
  assert.strictEqual(dead.phase, "error");
  assert.strictEqual(dead.meta, null);
  assert.strictEqual(deadMeta, 4);
  assert.strictEqual(deadSession, 0);
  assert.strictEqual(dead.error.code, "timeout");

  let gateSession = 0;
  const gate = await boot.recoverBoot({
    shell: "tiers-ledger",
    build: "20260926.1",
    attempts: 3,
    sleep: immediate,
    fetchMeta: async function () {
      return { shell: "tiers-ledger", clientBuild: "20260926.1" };
    },
    ensureAuth: async function () { return boot.hasSessionAuth("", ""); },
    fetchSession: async function () {
      gateSession += 1;
      return { player: { id: 1 } };
    }
  });
  assert.strictEqual(gate.phase, "gate");
  assert.strictEqual(gateSession, 0);

  let denied = 0;
  const unauthorized = await boot.recoverBoot({
    shell: "tiers-ledger",
    build: "20260926.1",
    attempts: 5,
    sleep: immediate,
    fetchMeta: async function () {
      return { shell: "tiers-ledger", clientBuild: "20260926.1" };
    },
    ensureAuth: async function () { return true; },
    fetchSession: async function () {
      denied += 1;
      throw fail(401);
    }
  });
  assert.strictEqual(unauthorized.phase, "error");
  assert.strictEqual(denied, 1);
  assert.strictEqual(unauthorized.error.status, 401);
  assert.strictEqual(unauthorized.meta.clientBuild, "20260926.1");

  let authChecks = 0;
  const blocked = await boot.recoverBoot({
    shell: "tiers-ledger",
    build: "20260926.1",
    fetchMeta: async function () { return { shell: "old", clientBuild: "20260926.1" }; },
    ensureAuth: async function () { authChecks += 1; return true; },
    fetchSession: async function () { authChecks += 1; return {}; }
  });
  assert.strictEqual(blocked.phase, "blocked");
  assert.strictEqual(authChecks, 0);

  const reload = await boot.recoverBoot({
    shell: "tiers-ledger",
    build: "20260923.2",
    fetchMeta: async function () { return { shell: "tiers-ledger", clientBuild: "20260926.1" }; },
    ensureAuth: async function () { authChecks += 1; return true; },
    fetchSession: async function () { authChecks += 1; return {}; }
  });
  assert.strictEqual(reload.phase, "reload");
  assert.strictEqual(reload.build, "20260926.1");
  assert.strictEqual(authChecks, 0);

  console.log("boot-recover ok");
})().catch(function (error) {
  console.error(error);
  process.exit(1);
});
