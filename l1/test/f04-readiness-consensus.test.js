// F-04 regression: /readyz must report a node that cannot make consensus
// progress. A stalled chain (finalized tip older than the readiness bound),
// a legacy validator that is still catching up on a skip-certificate chain,
// and a scheduled protocol version this binary cannot run are all "not ready"
// (503 with a machine-readable reason). /healthz stays process liveness only.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { BLOCK_INTERVAL_MS, NodeService, createRpcServer, produceFinalizedBlock } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
const MINUTE = 60_000;
const validatorPrivate = "81".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const genesisTimestamp = 1_700_000_000_000;
function genesis(chainId) {
    const pool = addressFromPublicKey(publicKeyFromPrivate("83".padStart(64, "0")));
    return {
        chainId,
        timestampMs: genesisTimestamp,
        validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
        activityOracles: [publicKeyFromPrivate("82".padStart(64, "0"))],
        activityPool: pool,
        allocations: [{ address: pool, amountAtoms: 1_000_000 }]
    };
}
const peers = { requestAttestations: async () => [], requestRoundSkips: async () => [], broadcastBlock: async () => { } };
async function withNode(chainId, body) {
    const dir = await mkdtemp(join(tmpdir(), "zyron-f04-"));
    const originalDateNow = Date.now;
    const journal = await SigningJournal.open(dir);
    const service = new NodeService(await ChainStore.open(genesis(chainId), dir), journal, validatorPrivate);
    const server = createRpcServer(service);
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    let nowMs = genesisTimestamp;
    Date.now = () => nowMs;
    try {
        await body({
            service,
            setNow: (value) => { nowMs = value; },
            readyz: async () => {
                const response = await fetch(`${base}/readyz`);
                return { status: response.status, body: await response.json() };
            }
        });
    }
    finally {
        Date.now = originalDateNow;
        await new Promise((resolveClose) => server.close(() => resolveClose()));
        journal.close();
        await rm(dir, { recursive: true, force: true });
    }
}
test("F-04: /readyz is 200 with a fresh tip and 503 stale-tip once no block was finalized for longer than the bound", async () => {
    await withNode("zyron-f04-stale", async ({ readyz, setNow, service }) => {
        setNow(genesisTimestamp + 9 * MINUTE);
        assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 0, reasons: [] } });
        setNow(genesisTimestamp + 11 * MINUTE);
        assert.deepEqual(await readyz(), { status: 503, body: { ready: false, height: 0, reasons: ["stale-tip"] } });
        assert.deepEqual(service.readiness(), { ready: false, height: 0, reasons: ["stale-tip"] });
    });
});
test("F-04: a stalled legacy validator reports stale-tip and consensus-catching-up, then 200 after the next finalized block", { timeout: 120_000 }, async () => {
    await withNode("zyron-f04-catchup", async ({ readyz, setNow, service }) => {
        let nowMs = genesisTimestamp + 45 * MINUTE;
        setNow(nowMs);
        assert.deepEqual(await readyz(), { status: 503, body: { ready: false, height: 0, reasons: ["stale-tip"] } });
        // First tick after the outage: the skip-certificate chain is longer than
        // one tick's work, so the validator is catching up.
        const first = await produceFinalizedBlock(service, peers, validatorPrivate, nowMs);
        assert.equal(first, null);
        assert.deepEqual(await readyz(), { status: 503, body: { ready: false, height: 0, reasons: ["stale-tip", "consensus-catching-up"] } });
        let block = null;
        for (let tick = 0; tick < 5 && !block; tick += 1) {
            nowMs += BLOCK_INTERVAL_MS;
            setNow(nowMs);
            block = await produceFinalizedBlock(service, peers, validatorPrivate, nowMs);
        }
        assert.ok(block, "the validator resumed");
        assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 1, reasons: [] } });
    });
});
test("F-04: a scheduled protocol version this binary does not support makes the node not ready", async () => {
    await withNode("zyron-f04-protocol", async ({ readyz, setNow, service }) => {
        setNow(genesisTimestamp + MINUTE);
        const chain = service.store.chain;
        const original = chain.protocolVersionAt.bind(chain);
        chain.protocolVersionAt = (height) => height > chain.height ? 4 : original(height);
        try {
            assert.deepEqual(await readyz(), { status: 503, body: { ready: false, height: 0, reasons: ["unsupported-next-protocol"] } });
        }
        finally {
            chain.protocolVersionAt = original;
        }
        assert.deepEqual(await readyz(), { status: 200, body: { ready: true, height: 0, reasons: [] } });
    });
});
test("F-04: /healthz stays process liveness only while the chain is stalled", async () => {
    await withNode("zyron-f04-health", async ({ setNow, service }) => {
        setNow(genesisTimestamp + 60 * MINUTE);
        const server = createRpcServer(service);
        await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
        try {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { ok: true, height: 0 });
        }
        finally {
            await new Promise((resolveClose) => server.close(() => resolveClose()));
        }
    });
});
