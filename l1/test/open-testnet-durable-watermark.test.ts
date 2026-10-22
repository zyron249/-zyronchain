// Open TESTNET follower forks after a cold start: the hosted instance has no
// persistent disk and restores the last published snapshot, which can be
// behind the tip it already finalized and served. Followers must only ever be
// served blocks inside a published snapshot (the durable watermark), so a
// restore never contradicts a block a follower holds.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const H = (n: number) => n.toString(16).padStart(64, "0");

test("watermark advances only to published snapshots that are on this chain", async () => {
  let published: { height: number; tipHash: string } | undefined;
  const local = new Map([[5, H(5)], [9, H(9)]]);
  const w = api.createDurableWatermark({ height: 3, tipHash: H(3), fetchPublished: async () => published, localHashAt: async (h: number) => local.get(h) });
  await w.refresh();
  assert.equal(w.height, 3);
  published = { height: 5, tipHash: H(5) }; await w.refresh();
  assert.equal(w.height, 5); assert.equal(w.tipHash, H(5));
  published = { height: 9, tipHash: H(99) }; await w.refresh();
  assert.equal(w.height, 5, "a snapshot from another branch never moves the watermark");
  assert.match(w.status().durableError, /not on this chain/);
  published = { height: 4, tipHash: H(4) }; await w.refresh();
  assert.equal(w.height, 5, "the watermark never moves back");
});

test("peer status is capped at the watermark", () => {
  const status = { chainId: "c", genesisHash: H(1), height: 20, tipHash: H(20) };
  assert.deepEqual(api.capPeerStatus(status, { height: 12, tipHash: H(12) }), { ...status, height: 12, tipHash: H(12) });
  assert.deepEqual(api.capPeerStatus(status, { height: 30, tipHash: H(30) }), status);
  assert.deepEqual(api.capPeerStatus(status, undefined), status);
});

test("readPublishedSnapshotTip reads the sealed tip; 404 means none yet", async () => {
  const secret = "s".repeat(32);
  const sealed = api.sealSnapshot({ format: "ZYRON-OPEN-TESTNET-STATE-V1", blocks: [{ hash: H(1) }, { hash: H(2) }] }, secret);
  const ok = await api.readPublishedSnapshotTip("http://x.invalid/s", secret, { fetchImpl: async () => new Response(sealed, { status: 200 }) });
  assert.deepEqual(ok, { height: 2, tipHash: H(2) });
  assert.equal(await api.readPublishedSnapshotTip("http://x.invalid/s", secret, { fetchImpl: async () => new Response("", { status: 404 }) }), undefined);
  await assert.rejects(api.readPublishedSnapshotTip("http://x.invalid/s", secret, { fetchImpl: async () => new Response("", { status: 500 }) }), /500/);
});

test("cold start from a snapshot behind the tip: followers never held a block the restored chain contradicts", { timeout: 1_500_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-durable-"));
  await chmod(root, 0o700);
  const secret = randomBytes(32).toString("base64");
  const chainId = "zyron-durable-testnet-1";
  let publishedSealed: Buffer | undefined;
  const durable = { intervalMs: 300, fetchPublished: async () => { if (!publishedSealed) return undefined; const b = api.openSnapshot(publishedSealed, secret); return { height: b.blocks.length, tipHash: b.blocks.at(-1).hash }; } };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let network: any;
  const until = async (label: string, check: () => Promise<unknown>, ms = 900_000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = await check().catch(() => undefined); if (v) return v; await sleep(500); } throw new Error(`timed out: ${label}`); };
  const json = async (base: string, p: string) => { const r = await fetch(base + p); return { status: r.status, body: await r.json() }; };
  try {
    await api.initNetwork(join(root, "a"), chainId);
    network = await api.runNetwork(join(root, "a"), { gatewayPort: 0, basePort: 19300 + Math.floor(Math.random() * 500) * 4, log: false, stateSecret: secret, durable });
    let base = `http://127.0.0.1:${network.port}`;
    await until("height past v6", async () => (await json(base, "/status")).body.height >= 102);
    assert.equal((await json(base, "/peer/status")).status, 503, "no durable block before the first publish");
    const snap = await fetch(`${base}/state/snapshot`);
    publishedSealed = Buffer.from(await snap.arrayBuffer());
    const h1 = Number(snap.headers.get("x-zyron-snapshot-height"));
    await until("chain moves past the published snapshot", async () => (await json(base, "/status")).body.height >= h1 + 3);
    const peerStatus = await until("peer status at watermark", async () => { const s = (await json(base, "/peer/status")).body; return s.height === h1 ? s : undefined; }) as { height: number };
    assert.equal(peerStatus.height, h1);
    assert.equal((await json(base, `/peer/blocks?from=${h1 + 1}&limit=10`)).status, 404, "blocks above the watermark are not served to followers");
    const served: string[] = [];
    for (let from = 1; from <= h1; from += 100) for (const b of (await json(base, `/peer/blocks?from=${from}&limit=100`)).body.blocks) served.push(b.hash);
    assert.equal(served.length, h1);
    const lostTip = (await json(base, "/status")).body.height;
    // The instance loses its disk; the next start restores the published (stale) snapshot.
    await network.shutdown(); network = undefined;
    const restored = await api.restoreNetwork(join(root, "b"), api.openSnapshot(publishedSealed, secret), chainId);
    assert.ok(restored.height < lostTip, "the restore is behind the tip that was finalized before the restart");
    network = await api.runNetwork(join(root, "b"), { gatewayPort: 0, basePort: 19300 + Math.floor(Math.random() * 500) * 4, log: false, stateSecret: secret, persistence: { mode: "snapshot-restore", restoredHeight: restored.height }, verifiedHistory: restored.verifiedHistory, durable });
    base = `http://127.0.0.1:${network.port}`;
    await until("restored chain finalizes past the lost tip", async () => (await json(base, "/status")).body.height > lostTip);
    for (let from = 1; from <= h1; from += 20) {
      const blocks = (await json(base, `/blocks?from=${from}&limit=20`)).body.blocks as Array<{ height: number; hash: string }>;
      for (const b of blocks) if (b.height <= h1) assert.equal(b.hash, served[b.height - 1], `block ${b.height} served to followers is unchanged after the restore`);
    }
    const ps = (await json(base, "/peer/status")).body;
    assert.equal(ps.height, h1, "after the restore, followers still see only the durable prefix");
  } finally {
    await network?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
