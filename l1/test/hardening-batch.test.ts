// Hardening batch (Nov 1): Red Team Session 1 retest LOW-1, LOW-2 and INFO
// items plus the mempool, faucet and /supply follow-ups. Node policy and
// gateway responses only; block validity, supply and allocations are unchanged.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { Mempool } from "../src/mempool.js";
import * as nodeApi from "../src/node.js";
import { NodeService, createRpcServer, type NodeServiceOptions } from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig, type Transaction } from "../src/types.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const script = (name: string) => pathToFileURL(join(l1Root, "scripts", name)).href;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 91;
const ORACLE = 92;
const POOL = 93;
const ALICE = 94;
const SINK = 97;

function genesis(chainId: string): GenesisConfig {
  return {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(POOL),
    allocations: [
      { address: addr(ALICE), amountAtoms: 1_000 * ATOMS_PER_ZYN },
      { address: addr(POOL), amountAtoms: 1_000 * ATOMS_PER_ZYN }
    ]
  } as GenesisConfig;
}

function transfer(g: GenesisConfig, sender: number, nonce: number, feeAtoms = 0, timestampOffset = 1): Transaction {
  return createTransfer({
    chainId: g.chainId, nonce, sender: addr(sender), receiver: addr(SINK),
    amountAtoms: 1, feeAtoms, timestampMs: g.timestampMs + timestampOffset
  }, key(sender), pub(sender), 1);
}

async function withService(
  chainId: string,
  options: NodeServiceOptions,
  run: (service: NodeService, g: GenesisConfig) => Promise<void> | void
): Promise<void> {
  const g = genesis(chainId);
  const directory = await mkdtemp(join(tmpdir(), "zyron-hardening-"));
  try {
    const store = await ChainStore.open(g, directory);
    await run(new NodeService(store, undefined, undefined, options), g);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withRpc<T>(service: NodeService, run: (base: string) => Promise<T>): Promise<T> {
  const server = createRpcServer(service);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }
}

// ---- 1. faucet nonce resync -------------------------------------------------

test("HARDEN-1: a non-2xx /tx that may have relayed reuses the same nonce, keeping the pending prefix", async () => {
  const { createFaucetNonceTracker } = await import(script("faucet-nonce.mjs"));
  const tracker = createFaucetNonceTracker();
  const now = 1_000_000;
  assert.equal(tracker.next(2, now), 3); tracker.accepted(3, now);
  assert.equal(tracker.next(2, now), 4); tracker.accepted(4, now);
  assert.equal(tracker.next(2, now), 5);
  tracker.rejected(5, { status: 502, error: "upstream timeout" });
  // Old behavior: a blind reset to chain state reused nonce 3 (still pending).
  assert.equal(tracker.next(2, now), 5, "nonces 3 and 4 are still pending; retry 5");
});

test("HARDEN-1: a nonce-conflict rejection proves the nonce is taken, so the tracker advances past it", async () => {
  const { createFaucetNonceTracker } = await import(script("faucet-nonce.mjs"));
  const tracker = createFaucetNonceTracker();
  const now = 1_000_000;
  assert.equal(tracker.next(2, now), 3); tracker.accepted(3, now);
  assert.equal(tracker.next(2, now), 4);
  tracker.rejected(4, { status: 400, error: "Conflicting sender nonce" });
  assert.equal(tracker.next(2, now), 5);
});

test("HARDEN-1: chain state still wins: a nonce the chain has passed is never reused, a regression resets", async () => {
  const { createFaucetNonceTracker } = await import(script("faucet-nonce.mjs"));
  const tracker = createFaucetNonceTracker();
  const now = 1_000_000;
  assert.equal(tracker.next(2, now), 3); tracker.accepted(3, now);
  assert.equal(tracker.next(2, now), 4);
  tracker.rejected(4, { status: 500, error: "" });
  assert.equal(tracker.next(6, now), 7, "chain moved past the rejected nonce");
  assert.equal(tracker.next(1, now), 2, "chain regression (restore) resets to chain state");
  // A definitive refusal that is not a nonce conflict does not advance.
  assert.equal(tracker.next(1, now), 2); tracker.accepted(2, now);
  assert.equal(tracker.next(1, now), 3);
  tracker.rejected(3, { status: 400, error: "Transfer fee 0 atoms is below this node's minimum transfer fee" });
  assert.equal(tracker.next(1, now), 3);
});

test("HARDEN-1: a proven-taken nonce stays taken before the first accepted drip and after an idle period", async () => {
  const { createFaucetNonceTracker } = await import(script("faucet-nonce.mjs"));
  // Before any accepted drip: ambiguous first drip, then a conflict on the retry.
  const fresh = createFaucetNonceTracker();
  const now = 1_000_000;
  assert.equal(fresh.next(0, now), 1);
  fresh.rejected(1, { status: 502, error: "upstream timeout" }, now);
  assert.equal(fresh.next(0, now), 1, "ambiguous drip: retry the same nonce");
  fresh.rejected(1, { status: 400, error: "Conflicting sender nonce" }, now);
  assert.equal(fresh.next(0, now), 2, "nonce 1 is proven taken; never reuse it");
  // After more than staleMs idle since the last accepted drip.
  const idle = createFaucetNonceTracker({ staleMs: 180_000 });
  assert.equal(idle.next(0, now), 1); idle.accepted(1, now);
  const later = now + 200_000;
  assert.equal(idle.next(0, later), 1, "stale cache falls back to chain state");
  idle.rejected(1, { status: 400, error: "Conflicting sender nonce" }, later);
  assert.equal(idle.next(0, later), 2, "nonce 1 is proven taken; never reuse it");
});

// ---- 2. /supply -------------------------------------------------------------

test("HARDEN-2: /supply recomputes at most once per SUPPLY_MIN_RECOMPUTE_MS even when the tip moves", async () => {
  let now = 5_000_000;
  await withService("zyron-hardening-supply-1", { nowMs: () => now }, (service) => {
    const minMs = (nodeApi as any).SUPPLY_MIN_RECOMPUTE_MS as number;
    assert.ok(Number.isSafeInteger(minMs) && minMs > 0 && minMs <= 30_000, "bounded recompute interval");
    const chain = (service as any).store.chain;
    let scans = 0;
    const realGetState = chain.getState.bind(chain);
    chain.getState = () => { scans += 1; return realGetState(); };
    const realTip = chain.tip;
    let tipHash = realTip.hash;
    Object.defineProperty(chain, "tip", { configurable: true, get: () => ({ ...realTip, hash: tipHash }) });
    const first = service.supply();
    assert.equal(scans, 1);
    for (let i = 0; i < 50; i += 1) { tipHash = `${i}`.padStart(64, "0"); service.supply(); }
    assert.equal(scans, 1, "a moving tip under load does not rescan every request");
    now += minMs;
    const later = service.supply();
    assert.equal(scans, 2);
    assert.equal(later.tipHash, tipHash);
    assert.equal(first.totalSupplyAtoms, later.totalSupplyAtoms);
  });
});

test("HARDEN-2: /supply keeps totalSupplyAtoms at the genesis supply and circulating = total - burned - pending - locked", async () => {
  await withService("zyron-hardening-supply-2", {}, (service) => {
    const report = service.supply() as any;
    assert.equal(report.totalSupplyAtoms, String(2_000 * ATOMS_PER_ZYN), "total is the fixed genesis supply");
    assert.equal(report.maxSupplyAtoms, String(MAX_SUPPLY_ATOMS), "the 50M cap is reported unchanged");
    assert.equal(report.supplyChanges, false, "the report states supply never changes");
    const total = BigInt(report.totalSupplyAtoms);
    assert.equal(BigInt(report.circulatingAtoms), total - BigInt(report.burnedAtoms) - BigInt(report.pendingAtoms) - BigInt(report.lockedAtoms));
  });
});

// ---- 3. faucet fee floor ----------------------------------------------------

test("HARDEN-3: both faucets read the fee floor from node /status through the shared helper", async () => {
  const fee = await import(script("faucet-fee.mjs"));
  const ok = (body: Record<string, unknown>) => ({ status: 200, body });
  assert.equal(fee.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: 1_000, fixedTransferFeeAtoms: null })), 1_000);
  assert.throws(() => fee.faucetTransferFeeAtoms(0, { status: 503, body: {} }), fee.FaucetFeeFloorError);
  const open = await import(script("open-testnet.mjs"));
  assert.equal(open.faucetTransferFeeAtoms, fee.faucetTransferFeeAtoms, "open-testnet re-exports the same helper");
  const walletGateway = await readFile(join(l1Root, "scripts", "public-testnet-rpc.mjs"), "utf8");
  assert.match(walletGateway, /faucetTransferFeeAtoms\(/, "the wallet-testnet faucet reads the node floor");
  assert.match(walletGateway, /nodeFetch\("\/status"\)/);
  assert.doesNotMatch(walletGateway, /FAUCET_DRIP_ATOMS, feeAtoms: 0\b/, "no hard-coded zero faucet fee");
});

// ---- 4. atomic same-nonce replacement --------------------------------------

test("HARDEN-4: a same-nonce replacement that fails a later capacity check leaves the original in place", () => {
  const g = genesis("zyron-hardening-mempool-1");
  const original = transfer(g, ALICE, 1, 1_000);
  const replacement = transfer(g, ALICE, 1, 1_000_000);
  const originalBytes = Buffer.byteLength(JSON.stringify(original));
  const maxBytes = 1_000_000;
  // The transfer byte budget fits the original exactly, not the larger replacement.
  const mempool = new Mempool(10, 0, maxBytes, undefined, { protocolReserve: 1, protocolReserveBytes: maxBytes - originalBytes });
  mempool.add(original, 1);
  assert.throws(() => mempool.add(replacement, 2), /Mempool full/);
  assert.ok(mempool.has(original.txid), "original survives a failed replacement");
  assert.equal(mempool.size, 1);
  assert.equal(mempool.senderPendingCount(addr(ALICE)), 1);
  assert.equal(mempool.pendingTransferSpend(addr(ALICE)), 1n + 1_000n);
  assert.deepEqual(mempool.admittedAtOrBefore(1).map((entry) => entry.txid), [original.txid], "admission time kept");
  // The pool is still consistent: removing the original empties it.
  mempool.remove([original.txid]);
  assert.equal(mempool.size, 0);
});

test("HARDEN-4: the admission-time comment describes sender:nonce slots, not txids", async () => {
  const source = await readFile(join(l1Root, "src", "mempool.ts"), "utf8");
  assert.doesNotMatch(source, /admission time per txid/i);
});

// ---- 5. LOW-1 parked status -------------------------------------------------

test("HARDEN-5: node /tx reports a gapped transfer as parked, waiting for the missing nonce", async () => {
  await withService("zyron-hardening-parked-1", {}, async (service, g) => {
    await withRpc(service, async (base) => {
      const post = async (tx: Transaction) => {
        const response = await fetch(`${base}/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(tx) });
        return { status: response.status, body: await response.json() as any };
      };
      const parked = await post(transfer(g, ALICE, 3, 0));
      assert.equal(parked.status, 202);
      assert.equal(parked.body.status, "parked");
      assert.equal(parked.body.waitingForNonce, 1);
      assert.equal(typeof parked.body.txid, "string");
      const ready = await post(transfer(g, ALICE, 1, 0));
      assert.equal(ready.body.status, "pending");
      assert.equal("waitingForNonce" in ready.body, false);
    });
  });
});

test("HARDEN-5: the gateway view says parked instead of 'included in ~30s', keeping accepted/txid", async () => {
  const { submitAcceptedView } = await import(script("submit-view.mjs"));
  const parked = submitAcceptedView({ txid: "ab", status: "parked", waitingForNonce: 5 });
  assert.equal(parked.accepted, true);
  assert.equal(parked.txid, "ab");
  assert.equal(parked.status, "parked");
  assert.equal(parked.waitingForNonce, 5);
  assert.match(parked.note, /parked, waiting for nonce 5/i);
  assert.doesNotMatch(parked.note, /30 seconds/);
  const pending = submitAcceptedView({ txid: "cd", status: "pending" });
  assert.equal(pending.status, "pending");
  assert.match(pending.note, /about 30 seconds/);
  // An older node without a status field is reported as pending (compatible).
  assert.equal(submitAcceptedView({ txid: "ef" }).status, "pending");
});

// ---- 6. LOW-2 seen-expired cache --------------------------------------------

test("HARDEN-6: an expired parked tx cannot be resubmitted with a fresh TTL while its gap is still open", async () => {
  let now = 1_000_000;
  await withService("zyron-hardening-expired-1", { mempoolParkedTxTtlMs: 60_000, nowMs: () => now }, (service, g) => {
    const parked = transfer(g, ALICE, 3, 0);
    service.submitTransaction(parked);
    now += 60_001;
    assert.equal(service.evictExpiredParkedTransactions(), 1);
    assert.throws(() => service.submitTransaction(parked), /expired from this node's mempool.*nonce 1/);
    // Once the gap closes the same signed tx is admissible again.
    service.submitTransaction(transfer(g, ALICE, 1, 0));
    service.submitTransaction(transfer(g, ALICE, 2, 0));
    assert.equal(service.submitTransaction(parked), parked.txid);
  });
});

test("HARDEN-6: the seen-expired cache is bounded by size and TTL constants", async () => {
  const api = nodeApi as any;
  assert.ok(Number.isSafeInteger(api.SEEN_EXPIRED_CACHE_MAX_ENTRIES) && api.SEEN_EXPIRED_CACHE_MAX_ENTRIES > 0 && api.SEEN_EXPIRED_CACHE_MAX_ENTRIES <= 100_000);
  assert.ok(Number.isSafeInteger(api.SEEN_EXPIRED_CACHE_TTL_MS) && api.SEEN_EXPIRED_CACHE_TTL_MS > 0);
  let now = 1_000_000;
  await withService("zyron-hardening-expired-2", { mempoolParkedTxTtlMs: 60_000, nowMs: () => now }, (service, g) => {
    const parked = transfer(g, ALICE, 3, 0);
    service.submitTransaction(parked);
    now += 60_001;
    service.evictExpiredParkedTransactions();
    assert.throws(() => service.submitTransaction(parked), /expired/);
    now += api.SEEN_EXPIRED_CACHE_TTL_MS;
    assert.equal(service.submitTransaction(parked), parked.txid, "the cache entry itself expires");
  });
});

// ---- 7. /readyz build commit ------------------------------------------------

test("HARDEN-7: buildCommit reads a commit SHA from the environment and never echoes other values", async () => {
  const { buildCommit }: any = await import(new URL("../src/build-info.js", import.meta.url).href);
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(buildCommit({ RENDER_GIT_COMMIT: sha }), sha);
  assert.equal(buildCommit({ ZYRON_BUILD_COMMIT: "abc1234" }), "abc1234");
  assert.equal(buildCommit({}), "unknown");
  assert.equal(buildCommit({ RENDER_GIT_COMMIT: "hunter2-secret-token" }), "unknown");
  assert.equal(buildCommit({ RENDER_GIT_COMMIT: `${sha}\n` }), "unknown");
});

test("HARDEN-7: node /readyz exposes the build commit", async () => {
  const previous = process.env.RENDER_GIT_COMMIT;
  process.env.RENDER_GIT_COMMIT = "fedcba9876543210fedcba9876543210fedcba98";
  try {
    await withService("zyron-hardening-readyz-1", {}, async (service) => {
      await withRpc(service, async (base) => {
        const body = await (await fetch(`${base}/readyz`)).json() as any;
        assert.equal(body.commit, "fedcba9876543210fedcba9876543210fedcba98");
        assert.equal(typeof body.ready, "boolean");
      });
    });
  } finally {
    if (previous === undefined) delete process.env.RENDER_GIT_COMMIT; else process.env.RENDER_GIT_COMMIT = previous;
  }
});
