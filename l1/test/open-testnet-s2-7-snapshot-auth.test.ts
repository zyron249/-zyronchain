// S2-7: /state/snapshot auth-before-work + keeper quota isolation.
// Includes the acceptance tests from #1202 (test/s2-7-acceptance), now on
// main. Production path is serveAuthorizedSnapshotRoute, the same helper
// runNetwork uses.
//
// Design (no new Render env): keeper Bearer = HMAC-SHA256(
//   ZYRON_TESTNET_STATE_SECRET, "zyron-open-testnet-snapshot-keeper-v1") as hex.
// Raw secret is never accepted or sent. Unauthenticated, empty or invalid
// Authorization → 401 before any snapshots.fresh / takeRate / sealed read
// (S27-R2). There is no public bucket.
//
// No live endpoints, no network beyond 127.0.0.1, no real secrets.
// Fake tokens below are deliberately obvious and never logged by these tests.
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);

const H = (n: number) => n.toString(16).padStart(64, "0");
const GENESIS_HASH = H(0);
/** Obviously fake; never a real keeper credential / state secret. */
const FAKE_STATE_SECRET = "test-fake-state-secret-0001";
const FAKE_BAD_TOKEN = "test-fake-invalid-token-9999";
const keeperAuth = () => ({ authorization: `Bearer ${api.deriveSnapshotKeeperBearer(FAKE_STATE_SECRET)}` });

type SnapCalls = { fresh: number; current: number; refresh: number; sealedReads: number };

function spySnapshots(sealed = Buffer.from("sealed-fixture")) {
  const calls: SnapCalls = { fresh: 0, current: 0, refresh: 0, sealedReads: 0 };
  const tracked = {
    get sealed() {
      calls.sealedReads += 1;
      return sealed;
    },
    height: 42
  };
  const snapshots = {
    fresh() {
      calls.fresh += 1;
      return tracked;
    },
    current() {
      calls.current += 1;
      return tracked;
    },
    refresh() {
      calls.refresh += 1;
      return Promise.resolve(tracked);
    },
    ageSeconds() {
      return 0;
    }
  };
  return { snapshots, calls, sealed };
}

function limited(response: ServerResponse, rate: { retryAfterMs?: number }) {
  response.writeHead(429, {
    "content-type": "application/json",
    "retry-after": String(Math.max(1, Math.ceil((rate.retryAfterMs ?? 0) / 1000)))
  });
  response.end(JSON.stringify({ error: "rate limit exceeded" }));
}

function snapshotLimits(cap = 3) {
  return { snapshotKeeper: new api.WindowLimiter(cap, 3_600_000, 1) };
}
// Requests counted against a key (the #1200 WindowLimiter keeps { start, count } per key).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const used = (limiter: any, key: string): number => limiter.hits.get(key)?.count ?? 0;

/**
 * HTTP server that dispatches GET /state/snapshot through the same helper
 * runNetwork uses (serveAuthorizedSnapshotRoute).
 */
async function listenRunNetworkSnapshotPath(
  snapshots: ReturnType<typeof spySnapshots>["snapshots"],
  {
    stateSecret = FAKE_STATE_SECRET,
    limits = snapshotLimits(3)
  }: { stateSecret?: string; limits?: ReturnType<typeof snapshotLimits> } = {}
) {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/state/snapshot" && stateSecret) {
      return api.serveAuthorizedSnapshotRoute(res, snapshots, {
        genesisHash: GENESIS_HASH,
        stateSecret,
        authorization: req.headers.authorization,
        limits,
        limited,
        sendUnauthorized: (response: ServerResponse) => {
          response.writeHead(401, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "unauthorized" }));
        }
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/state/snapshot`,
    limits,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

test("S27 guard: acceptance file has no todo marks or STRICT gate", async () => {
  const src = await readFile(join(l1Root, "test", "open-testnet-s2-7-snapshot-auth.test.ts"), "utf8");
  // Operational gates only (this assertion text is allowed to name them).
  assert.equal(/process\.env\.ZYRON_S27_STRICT/.test(src), false, "must not read ZYRON_S27_STRICT");
  assert.equal(/\{\s*todo\s*[:}]/.test(src), false, "must not use node:test todo option");
  assert.equal(/test\.todo\s*\(/.test(src), false, "must not call test.todo");
});

test("S27 derived keeper bearer: raw secret never accepted; derived value is", () => {
  const derived = api.deriveSnapshotKeeperBearer(FAKE_STATE_SECRET);
  assert.equal(typeof derived, "string");
  assert.equal(derived.length, 64); // sha256 hex
  assert.notEqual(derived, FAKE_STATE_SECRET);
  assert.equal(api.snapshotClientRole(`Bearer ${derived}`, FAKE_STATE_SECRET), "keeper");
  assert.equal(api.snapshotClientRole(`Bearer ${FAKE_STATE_SECRET}`, FAKE_STATE_SECRET), "reject", "raw secret must not authenticate");
  assert.equal(api.timingSafeBearerToken(`Bearer ${FAKE_STATE_SECRET}`, derived), false);
  assert.equal(api.timingSafeBearerToken(`Bearer ${derived}`, derived), true);
});

test("S27 constant-time compare covers length (SHA-256 then timingSafeEqual)", () => {
  const derived = api.deriveSnapshotKeeperBearer(FAKE_STATE_SECRET);
  assert.equal(api.timingSafeTokenEqual("short", "much-longer-token-value"), false);
  assert.equal(api.timingSafeTokenEqual(derived, derived), true);
  assert.equal(api.timingSafeTokenEqual(derived, derived + "x"), false);
  assert.equal(api.timingSafeTokenEqual("", "x"), false);
  assert.equal(api.timingSafeBearerToken(`Bearer ${FAKE_BAD_TOKEN}`, derived), false);
  assert.equal(api.timingSafeBearerToken(`Bearer ${derived}x`, derived), false);
  assert.equal(api.timingSafeBearerToken("Basic nope", derived), false);
  assert.equal(api.timingSafeBearerToken(undefined, derived), false);
  assert.equal(api.timingSafeBearerToken(`Bearer ${derived}`, ""), false);
  assert.equal(api.snapshotClientRole(undefined, FAKE_STATE_SECRET), "reject", "anonymous is rejected (S27-R2)");
  assert.equal(api.snapshotClientRole("", FAKE_STATE_SECRET), "reject", "empty Authorization is rejected (S27-R2)");
  assert.equal(api.snapshotClientRole(`Bearer ${derived}`, undefined), "reject", "no configured secret fails closed");
  assert.equal(api.snapshotClientRole(`Bearer ${FAKE_BAD_TOKEN}`, FAKE_STATE_SECRET), "reject");
});

// ---- S27-T1 ----------------------------------------------------------------
// Original checklist intent (S2-7 / S27-R2): unauthenticated requests get 401
// before any work: no cache read, no refresh, no sealed bytes, no limiter.

test("S27-T1 snapshot-route-rejects-unauthenticated", async () => {
  const { snapshots, calls } = spySnapshots();
  const limits = snapshotLimits(3);
  const gw = await listenRunNetworkSnapshotPath(snapshots, { limits });
  try {
    for (const headers of [{}, { authorization: "" }]) {
      const response = await fetch(gw.url, { headers });
      assert.equal(response.status, 401, `anonymous must be 401; got ${response.status}`);
      assert.deepEqual(await response.json(), { error: "unauthorized" });
    }
    assert.equal(calls.fresh, 0, "fresh not called");
    assert.equal(calls.current, 0, "current not called");
    assert.equal(calls.refresh, 0, "refresh not called");
    assert.equal(calls.sealedReads, 0, "no sealed buffer read");
    assert.equal(limits.snapshotKeeper.hits.size, 0, "keeper limiter untouched");
    assert.equal("snapshotPublic" in limits, false, "there is no public bucket");
  } finally {
    await gw.close();
  }
});

// ---- S27-T2 ----------------------------------------------------------------

test("S27-T2 snapshot-route-rejects-before-cache-work", async () => {
  const { snapshots, calls } = spySnapshots();
  const limits = snapshotLimits(3);
  const gw = await listenRunNetworkSnapshotPath(snapshots, { limits });
  try {
    const response = await fetch(gw.url, { headers: bearer(FAKE_BAD_TOKEN) });
    assert.ok(response.status === 401 || response.status === 403, `invalid bearer must be 401/403; got ${response.status}`);
    assert.equal(calls.fresh, 0, "fresh not called");
    assert.equal(calls.current, 0, "current not called");
    assert.equal(calls.refresh, 0, "refresh not called");
    assert.equal(calls.sealedReads, 0, "no sealed buffer read");
    assert.equal(used(limits.snapshotKeeper, "keeper"), 0);
    await response.arrayBuffer();
  } finally {
    await gw.close();
  }
});

// ---- S27-T3 ----------------------------------------------------------------

test("S27-T3 snapshot-public-cannot-exhaust-keeper", async () => {
  const { snapshots } = spySnapshots();
  const limits = snapshotLimits(3);
  const gw = await listenRunNetworkSnapshotPath(snapshots, { limits });
  try {
    for (let i = 0; i < 10; i += 1) {
      const pub = await fetch(gw.url);
      assert.equal(pub.status, 401, `anonymous ${i}`);
      await pub.arrayBuffer();
    }
    assert.equal(used(limits.snapshotKeeper, "keeper"), 0, "anonymous requests spend no keeper slot");
    for (let i = 0; i < 3; i += 1) {
      const keeper = await fetch(gw.url, { headers: keeperAuth() });
      assert.equal(keeper.status, 200, `keeper ${i} must succeed after anonymous flood; got ${keeper.status}`);
      await keeper.arrayBuffer();
    }
    const capped = await fetch(gw.url, { headers: keeperAuth() });
    assert.equal(capped.status, 429, "keeper bucket still has its own cap");
    await capped.arrayBuffer();
  } finally {
    await gw.close();
  }
});

// ---- S27-T4 (renamed: quota isolation; production cache has no eviction hook) ---

test("S27-T4 snapshot-keeper-not-rate-limited-by-public", async () => {
  const { snapshots, calls } = spySnapshots();
  const limits = snapshotLimits(3);
  const gw = await listenRunNetworkSnapshotPath(snapshots, { limits });
  try {
    const warm = await fetch(gw.url, { headers: keeperAuth() });
    assert.equal(warm.status, 200);
    await warm.arrayBuffer();
    const freshAfterWarm = calls.fresh;

    for (let i = 0; i < 5; i += 1) {
      const pub = await fetch(gw.url);
      assert.equal(pub.status, 401);
      await pub.arrayBuffer();
    }
    const again = await fetch(gw.url, { headers: keeperAuth() });
    assert.equal(
      again.status,
      200,
      `keeper must not be forced to 429/503 from public quota alone; got ${again.status}`
    );
    await again.arrayBuffer();
    assert.ok(calls.fresh >= freshAfterWarm, "keeper still reads cache after public flood");
  } finally {
    await gw.close();
  }
});

// ---- S27-T5 ----------------------------------------------------------------

test("S27-T5 snapshot-auth-concurrency-isolation", async () => {
  const { snapshots } = spySnapshots();
  const limits = snapshotLimits(3);
  const gw = await listenRunNetworkSnapshotPath(snapshots, { limits });
  try {
    const publicN = 8;
    const keeperM = 3;
    const publicReqs = Array.from({ length: publicN }, () => fetch(gw.url));
    const keeperReqs = Array.from({ length: keeperM }, () => fetch(gw.url, { headers: keeperAuth() }));
    const [publicResults, keeperResults] = await Promise.all([Promise.all(publicReqs), Promise.all(keeperReqs)]);
    for (const r of publicResults) await r.arrayBuffer();
    for (const r of keeperResults) await r.arrayBuffer();

    const publicStatuses = publicResults.map((r) => r.status);
    const keeperStatuses = keeperResults.map((r) => r.status);
    assert.ok(publicStatuses.every((s) => s === 401), `every anonymous request is 401; got ${publicStatuses.join(",")}`);
    assert.ok(
      keeperStatuses.every((s) => s === 200),
      `concurrent anonymous requests must not reduce keeper allows; keeper statuses=${keeperStatuses.join(",")}`
    );
    assert.equal(used(limits.snapshotKeeper, "keeper"), keeperM, "only keeper requests are counted");
  } finally {
    await gw.close();
  }
});

// ---- Merge guards (S27-R1) --------------------------------------------------

test("S27 merge guard: one WindowLimiter, runNetwork wires the authorized route and only the keeper bucket", async () => {
  const src = await readFile(join(l1Root, "scripts", "open-testnet.mjs"), "utf8");
  assert.equal(src.match(/export class WindowLimiter\b/g)?.length, 1, "exactly one export class WindowLimiter");
  assert.equal(src.match(/class WindowLimiter\b/g)?.length, 1, "no second (unexported) WindowLimiter");
  assert.match(src, /if \(path === "\/state\/snapshot" && stateSecret\) \{[\s\S]{0,200}return serveAuthorizedSnapshotRoute\(/, "runNetwork routes /state/snapshot through serveAuthorizedSnapshotRoute");
  assert.equal(/snapshotPublic/.test(src), false, "no public snapshot bucket");
  assert.equal(/limits\.snapshot\.take/.test(src), false, "no shared snapshot bucket");
  assert.match(src, /snapshotKeeper: new WindowLimiter\(30, 3_600_000, 1\)/);
  // #1200 relay/limiter protections survive the merge.
  assert.match(src, /const shortWindowOpts = \{ evictOnFull: true, prefixCap: RATE_LIMITER_PREFIX_CAP_DEFAULT \};/);
  for (const name of ["read", "write", "relayIp"]) {
    assert.match(src, new RegExp(`\\b${name}: new WindowLimiter\\([^\\n]*, 60_000, limiterMaxKeys, shortWindowOpts\\)`), `${name} keeps limiterMaxKeys + shortWindowOpts`);
  }
  assert.match(src, /rateLimiters: rateLimitersHealth\(limits\)/, "/health still reports rateLimiters");
});
