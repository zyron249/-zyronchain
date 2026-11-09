// S2-7 acceptance gaps (Security checklist acceptance-gaps-2026-11-09.md).
// Base: origin/main 86d1d7a293161ee5e584776ce3f4c4467cabb234 (#1178).
// Anchors: open-testnet.mjs:2329-2330 (route), :1313-1329 (serve + late takeRate),
// :1960 (shared WindowLimiter(30, 1h, maxKeys=1)).
//
// These tests encode the S2-7 acceptance criteria against today's production
// wiring (no HTTP auth on GET /state/snapshot; one shared "global" snapshot
// limiter key). They FAIL on this base by design.
//
// CI choice: each test is marked `{ todo: true }` so the suite stays green
// until the S2-7 fix PR lands and removes `todo`. Hard-fail evidence was
// captured before commit (see PR body). Run without todo via:
//   ZYRON_S27_STRICT=1 node --import tsx --test ...  (or strip todo locally)
//
// No fixes, no live endpoints, no network beyond 127.0.0.1, no real secrets.
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
/** Obviously fake; never a real keeper credential. */
const FAKE_KEEPER_TOKEN = "test-fake-keeper-token-0001";
const FAKE_BAD_TOKEN = "test-fake-invalid-token-9999";
const STATE_SECRET_PRESENT = true; // route is only mounted when stateSecret is set
const STRICT = process.env.ZYRON_S27_STRICT === "1";
const todo = STRICT ? false : true;

// Production-equivalent of the nested WindowLimiter at open-testnet.mjs ~1939
// (not exported on this base). Shape matches :1960 — limit/window/maxKeys.
class ProdWindowLimiter {
  limit: number;
  windowMs: number;
  maxKeys: number;
  hits = new Map<string, { start: number; count: number }>();
  constructor(limit: number, windowMs: number, maxKeys = 50_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.maxKeys = maxKeys;
  }
  take(key: string, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || now - entry.start >= this.windowMs) {
      if (!entry && this.hits.size >= this.maxKeys) {
        for (const [k, e] of this.hits) if (now - e.start >= this.windowMs) this.hits.delete(k);
      }
      if (!entry && this.hits.size >= this.maxKeys) return { allowed: false, retryAfterMs: this.windowMs };
      entry = { start: now, count: 0 };
      this.hits.set(key, entry);
    }
    if (entry.count >= this.limit) return { allowed: false, retryAfterMs: entry.start + this.windowMs - now };
    entry.count += 1;
    return { allowed: true as const };
  }
  count(key: string) {
    return this.hits.get(key)?.count ?? 0;
  }
}

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

/**
 * Production-faithful gateway branch for GET /state/snapshot when stateSecret
 * is set (open-testnet.mjs:2329-2330): NO auth check; takeRate always uses the
 * shared "global" key on a maxKeys=1 limiter.
 */
async function listenProductionSnapshotRoute(
  snapshots: ReturnType<typeof spySnapshots>["snapshots"],
  {
    limiter = new ProdWindowLimiter(3, 3_600_000, 1),
    takeRate
  }: {
    limiter?: ProdWindowLimiter;
    takeRate?: () => { allowed: boolean; retryAfterMs?: number };
  } = {}
) {
  assert.equal(STATE_SECRET_PRESENT, true, "harness models the stateSecret-mounted route");
  const take = takeRate ?? (() => limiter.take("global"));
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/state/snapshot") {
      // Deliberate gap: production ignores Authorization entirely.
      return api.serveSnapshotRoute(res, snapshots, {
        genesisHash: GENESIS_HASH,
        takeRate: take,
        limited
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/state/snapshot`;
  return {
    url,
    limiter,
    close: () => new Promise<void>((r) => server.close(() => r()))
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` };
}

// ---- source anchors (must change when S2-7 lands) --------------------------

test(
  "S27 source: /state/snapshot authenticates before serveSnapshotRoute and does not share one global key",
  { todo },
  async () => {
    const src = await readFile(join(l1Root, "scripts", "open-testnet.mjs"), "utf8");
    const routeIdx = src.indexOf('path === "/state/snapshot"');
    assert.ok(routeIdx >= 0, "route branch missing");
    const routeWindow = src.slice(routeIdx, routeIdx + 500);
    assert.match(
      routeWindow,
      /401|403|authorize|authorization|Bearer|keeper/i,
      "S2-7: unauthenticated /state/snapshot must be refused before serveSnapshotRoute"
    );
    assert.equal(
      /take\(\s*["']global["']\s*\)/.test(routeWindow) && !/keeper/i.test(routeWindow),
      false,
      "S2-7: snapshot takeRate must not be a single shared global key with no keeper bucket"
    );
    assert.match(
      src,
      /snapshot:\s*new WindowLimiter\(\s*30\s*,\s*3_?600_?000\s*,\s*1\s*\)/,
      "anchor :1960 still names the shared snapshot limiter (update when split)"
    );
  }
);

// ---- S27-T1 ----------------------------------------------------------------

test(
  "S27-T1 snapshot-route-rejects-unauthenticated",
  { todo },
  async () => {
    const { snapshots, calls } = spySnapshots();
    const limiter = new ProdWindowLimiter(3, 3_600_000, 1);
    const gw = await listenProductionSnapshotRoute(snapshots, { limiter });
    try {
      const before = limiter.count("global");
      const response = await fetch(gw.url); // no Authorization
      assert.ok(
        response.status === 401 || response.status === 403,
        `unauthenticated must be 401/403 before any work; got ${response.status}`
      );
      assert.equal(calls.fresh, 0, "snapshots.fresh must not run for unauthenticated");
      assert.equal(calls.current, 0, "snapshots.current must not run for unauthenticated");
      assert.equal(calls.refresh, 0, "snapshots.refresh must not run for unauthenticated");
      assert.equal(calls.sealedReads, 0, "sealed buffer must not be read");
      assert.equal(limiter.count("global"), before, "snapshot limiter count unchanged");
      await response.arrayBuffer(); // drain
    } finally {
      await gw.close();
    }
  }
);

// ---- S27-T2 ----------------------------------------------------------------

test(
  "S27-T2 snapshot-route-rejects-before-cache-work",
  { todo },
  async () => {
    const { snapshots, calls } = spySnapshots();
    const gw = await listenProductionSnapshotRoute(snapshots);
    try {
      const response = await fetch(gw.url, { headers: bearer(FAKE_BAD_TOKEN) });
      assert.ok(
        response.status === 401 || response.status === 403,
        `invalid bearer must be 401/403; got ${response.status}`
      );
      assert.equal(calls.fresh, 0, "fresh not called");
      assert.equal(calls.current, 0, "current not called");
      assert.equal(calls.refresh, 0, "refresh not called");
      assert.equal(calls.sealedReads, 0, "no sealed buffer read");
      await response.arrayBuffer();
    } finally {
      await gw.close();
    }
  }
);

// ---- S27-T3 ----------------------------------------------------------------

test(
  "S27-T3 snapshot-public-cannot-exhaust-keeper",
  { todo },
  async () => {
    // Cap=3 for speed; production uses 30 — same shared-key shape (maxKeys=1).
    const { snapshots } = spySnapshots();
    const limiter = new ProdWindowLimiter(3, 3_600_000, 1);
    const gw = await listenProductionSnapshotRoute(snapshots, { limiter });
    try {
      for (let i = 0; i < 3; i += 1) {
        const pub = await fetch(gw.url); // unauthenticated / public bucket
        assert.equal(pub.status, 200, `public seed ${i}`);
        await pub.arrayBuffer();
      }
      const keeper = await fetch(gw.url, { headers: bearer(FAKE_KEEPER_TOKEN) });
      assert.equal(
        keeper.status,
        200,
        `authenticated keeper must still succeed after public cap; got ${keeper.status}`
      );
      await keeper.arrayBuffer();
    } finally {
      await gw.close();
    }
  }
);

// ---- S27-T4 ----------------------------------------------------------------

test(
  "S27-T4 snapshot-keeper-cache-not-evicted-by-public",
  { todo },
  async () => {
    const { snapshots } = spySnapshots();
    const limiter = new ProdWindowLimiter(3, 3_600_000, 1);
    const gw = await listenProductionSnapshotRoute(snapshots, { limiter });
    try {
      // Keeper warms / uses the cache first.
      const warm = await fetch(gw.url, { headers: bearer(FAKE_KEEPER_TOKEN) });
      assert.equal(warm.status, 200);
      await warm.arrayBuffer();

      // Public flood that exhausts the shared 30/h-style global key.
      for (let i = 0; i < 5; i += 1) {
        const pub = await fetch(gw.url);
        await pub.arrayBuffer();
      }

      const again = await fetch(gw.url, { headers: bearer(FAKE_KEEPER_TOKEN) });
      assert.equal(
        again.status,
        200,
        `keeper must not be forced to 429/503 from public quota alone; got ${again.status}`
      );
      await again.arrayBuffer();
    } finally {
      await gw.close();
    }
  }
);

// ---- S27-T5 ----------------------------------------------------------------

test(
  "S27-T5 snapshot-auth-concurrency-isolation",
  { todo },
  async () => {
    const { snapshots } = spySnapshots();
    // Shared production limiter: public and keeper contend on one key.
    const limiter = new ProdWindowLimiter(3, 3_600_000, 1);
    const gw = await listenProductionSnapshotRoute(snapshots, { limiter });
    try {
      const publicN = 8;
      const keeperM = 3;
      const publicReqs = Array.from({ length: publicN }, () => fetch(gw.url));
      const keeperReqs = Array.from({ length: keeperM }, () =>
        fetch(gw.url, { headers: bearer(FAKE_KEEPER_TOKEN) })
      );
      const [publicResults, keeperResults] = await Promise.all([
        Promise.all(publicReqs),
        Promise.all(keeperReqs)
      ]);
      for (const r of publicResults) await r.arrayBuffer();
      for (const r of keeperResults) await r.arrayBuffer();

      const publicStatuses = publicResults.map((r) => r.status);
      const keeperStatuses = keeperResults.map((r) => r.status);
      const public429 = publicStatuses.filter((s) => s === 429).length;
      assert.ok(public429 > 0, `expected some public 429s under shared cap; got ${publicStatuses.join(",")}`);
      assert.ok(
        keeperStatuses.every((s) => s === 200),
        `public 429s must not reduce keeper allows; keeper statuses=${keeperStatuses.join(",")}`
      );
    } finally {
      await gw.close();
    }
  }
);
