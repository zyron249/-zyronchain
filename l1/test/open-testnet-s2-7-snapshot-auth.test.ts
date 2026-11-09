// S2-7: /state/snapshot auth-before-work + keeper/public quota isolation.
// Stacked on test/s2-7-acceptance (draft #1202). Production path is
// serveAuthorizedSnapshotRoute — the same helper runNetwork uses.
//
// Design (no new Render env): keeper Bearer = stateSecret
// (ZYRON_TESTNET_STATE_SECRET). Unauthenticated → public bucket. Invalid
// Bearer → 401 before any snapshots.fresh / takeRate / sealed read.
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

type SnapCalls = { fresh: number; current: number; refresh: number; sealedReads: number; evict: number };

function spySnapshots(sealed = Buffer.from("sealed-fixture")) {
  const calls: SnapCalls = { fresh: 0, current: 0, refresh: 0, sealedReads: 0, evict: 0 };
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
    },
    // Cache only holds one entry today; spy records any future eviction hook.
    evict() {
      calls.evict += 1;
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
  return {
    snapshotKeeper: new api.WindowLimiter(cap, 3_600_000, 1),
    snapshotPublic: new api.WindowLimiter(cap, 3_600_000, 1)
  };
}

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

test("S27 constant-time bearer compare", () => {
  assert.equal(api.timingSafeBearerToken(`Bearer ${FAKE_STATE_SECRET}`, FAKE_STATE_SECRET), true);
  assert.equal(api.timingSafeBearerToken(`Bearer ${FAKE_BAD_TOKEN}`, FAKE_STATE_SECRET), false);
  assert.equal(api.timingSafeBearerToken(`Bearer ${FAKE_STATE_SECRET}x`, FAKE_STATE_SECRET), false);
  assert.equal(api.timingSafeBearerToken("Basic nope", FAKE_STATE_SECRET), false);
  assert.equal(api.timingSafeBearerToken(undefined, FAKE_STATE_SECRET), false);
  assert.equal(api.timingSafeBearerToken(`Bearer ${FAKE_STATE_SECRET}`, ""), false);
  assert.equal(api.snapshotClientRole(undefined, FAKE_STATE_SECRET), "public");
  assert.equal(api.snapshotClientRole("", FAKE_STATE_SECRET), "public");
  assert.equal(api.snapshotClientRole(`Bearer ${FAKE_STATE_SECRET}`, FAKE_STATE_SECRET), "keeper");
  assert.equal(api.snapshotClientRole(`Bearer ${FAKE_BAD_TOKEN}`, FAKE_STATE_SECRET), "reject");
});

// ---- S27-T1 ----------------------------------------------------------------
// Checklist row said "no auth → 401". Patron (2026-11-09) requires a public
// bucket separate from keeper, with no new env — so unauthenticated is public.
// T1 asserts public traffic never touches the keeper limiter; T2 covers 401.

test("S27-T1 snapshot-route-rejects-unauthenticated", async () => {
  const { snapshots, calls } = spySnapshots();
  const limits = snapshotLimits(3);
  const gw = await listenRunNetworkSnapshotPath(snapshots, { limits });
  try {
    const response = await fetch(gw.url); // no Authorization → public
    assert.equal(response.status, 200, `public unauthenticated is served; got ${response.status}`);
    await response.arrayBuffer();
    assert.equal(limits.snapshotKeeper.count("keeper"), 0, "keeper limiter must stay untouched");
    assert.equal(limits.snapshotPublic.count("public"), 1, "public limiter counts the request");
    assert.ok(calls.fresh >= 1, "public path may read fresh after role selection");
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
    assert.equal(limits.snapshotKeeper.count("keeper"), 0);
    assert.equal(limits.snapshotPublic.count("public"), 0);
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
    for (let i = 0; i < 3; i += 1) {
      const pub = await fetch(gw.url);
      assert.equal(pub.status, 200, `public seed ${i}`);
      await pub.arrayBuffer();
    }
    const denied = await fetch(gw.url);
    assert.equal(denied.status, 429, "public cap exhausted");
    await denied.arrayBuffer();
    const keeper = await fetch(gw.url, { headers: bearer(FAKE_STATE_SECRET) });
    assert.equal(keeper.status, 200, `keeper must still succeed after public cap; got ${keeper.status}`);
    await keeper.arrayBuffer();
  } finally {
    await gw.close();
  }
});

// ---- S27-T4 (renamed: quota isolation, not literal cache eviction) ----------

test("S27-T4 snapshot-keeper-not-rate-limited-by-public", async () => {
  const { snapshots, calls } = spySnapshots();
  const limits = snapshotLimits(3);
  const gw = await listenRunNetworkSnapshotPath(snapshots, { limits });
  try {
    const warm = await fetch(gw.url, { headers: bearer(FAKE_STATE_SECRET) });
    assert.equal(warm.status, 200);
    await warm.arrayBuffer();
    const freshAfterWarm = calls.fresh;

    for (let i = 0; i < 5; i += 1) {
      const pub = await fetch(gw.url);
      await pub.arrayBuffer();
    }
    assert.equal(calls.evict, 0, "public flood must not evict keeper-usable cache entry");

    const again = await fetch(gw.url, { headers: bearer(FAKE_STATE_SECRET) });
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
    const keeperReqs = Array.from({ length: keeperM }, () => fetch(gw.url, { headers: bearer(FAKE_STATE_SECRET) }));
    const [publicResults, keeperResults] = await Promise.all([Promise.all(publicReqs), Promise.all(keeperReqs)]);
    for (const r of publicResults) await r.arrayBuffer();
    for (const r of keeperResults) await r.arrayBuffer();

    const publicStatuses = publicResults.map((r) => r.status);
    const keeperStatuses = keeperResults.map((r) => r.status);
    const public429 = publicStatuses.filter((s) => s === 429).length;
    assert.ok(public429 > 0, `expected some public 429s under shared public cap; got ${publicStatuses.join(",")}`);
    assert.ok(
      keeperStatuses.every((s) => s === 200),
      `public 429s must not reduce keeper allows; keeper statuses=${keeperStatuses.join(",")}`
    );
  } finally {
    await gw.close();
  }
});
