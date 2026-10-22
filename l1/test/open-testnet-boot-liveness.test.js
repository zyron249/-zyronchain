// R21-1046-L2: while the open TESTNET downloads, decrypts and replays its
// sealed snapshot, the boot handler answers GET /health 200 so the host's
// health check passes. That liveness must stop (503) when start-up stops making
// progress, otherwise a stalled restore is never restarted. It must not be a
// plain wall-clock limit: a large snapshot on a slow free instance replays for
// a long time while still progressing.
import assert from "node:assert/strict";
import { readdir, readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
function call(handler, method, url) {
    let code = 0;
    let raw = "";
    handler({ method, url }, { writeHead(c) { code = c; }, end(b) { raw = b ?? ""; } });
    return { code, body: raw ? JSON.parse(raw) : {} };
}
test("boot /health is 200 while start-up progresses and 503 once it stalls", () => {
    const boot = api.createBootState(false);
    boot.enter("replay");
    const handler = api.createBootHandler(boot, { stallMs: 60_000 });
    const fresh = call(handler, "GET", "/health");
    assert.equal(fresh.code, 200);
    assert.equal(fresh.body.status, "starting");
    assert.equal(fresh.body.phase, "replay");
    boot.lastProgressAtMs = Date.now() - 60_001;
    for (const path of ["/health", "/healthz", "/readyz", "/status"]) {
        const stalled = call(handler, "GET", path);
        assert.equal(stalled.code, 503, path);
        assert.equal(stalled.body.status, "stalled", path);
        assert.equal(stalled.body.phase, "replay", path);
    }
    boot.progress();
    assert.equal(call(handler, "GET", "/health").code, 200);
});
test("boot /health stays 200 for a long start-up that keeps progressing (no wall-clock cap)", () => {
    const boot = api.createBootState(false);
    boot.enter("replay");
    boot.startedAtMs = Date.now() - 6 * 60 * 60_000;
    boot.progress();
    const handler = api.createBootHandler(boot, { stallMs: 60_000 });
    const health = call(handler, "GET", "/health");
    assert.equal(health.code, 200);
    assert.equal(health.body.status, "starting");
    assert.equal(call(handler, "GET", "/readyz").code, 503);
});
test("boot default stall limit is bounded and longer than one snapshot download attempt", () => {
    assert.ok(Number.isSafeInteger(api.BOOT_STALL_MS));
    assert.ok(api.BOOT_STALL_MS > 180_000 && api.BOOT_STALL_MS <= 15 * 60_000, String(api.BOOT_STALL_MS));
    const boot = api.createBootState(false);
    boot.lastProgressAtMs = Date.now() - api.BOOT_STALL_MS - 1;
    assert.equal(call(api.createBootHandler(boot), "GET", "/health").code, 503);
});
test("phase changes count as progress", () => {
    const boot = api.createBootState(false);
    boot.lastProgressAtMs = Date.now() - 120_000;
    boot.enter("decrypt");
    assert.equal(call(api.createBootHandler(boot, { stallMs: 60_000 }), "GET", "/health").code, 200);
});
test("snapshot restore reports progress for every replayed block and every validator copy", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-boot-liveness-"));
    try {
        const source = join(root, "source");
        await api.initNetwork(source, "zyron-boot-liveness-testnet-1");
        const json = async (path) => JSON.parse(await readFile(path, "utf8"));
        const keys = {};
        for (const file of await readdir(join(source, "keys")))
            keys[file.replace(/\.json$/, "")] = (await json(join(source, "keys", file))).privateKey;
        const blocks = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
        const bundle = { format: "ZYRON-OPEN-TESTNET-STATE-V1", genesis: await json(join(source, "genesis.json")), network: await json(join(source, "network.json")), keys, blocks };
        let calls = 0;
        const restored = await api.restoreNetwork(join(root, "restored"), bundle, bundle.genesis.chainId, { onProgress: () => { calls += 1; } });
        assert.equal(restored.height, blocks.length);
        assert.ok(calls >= blocks.length + 3, `progress reported ${calls} times for ${blocks.length} blocks`);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("fresh TEST genesis initialisation reports progress for every produced and committed block (Round 22)", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-boot-liveness-init-"));
    try {
        let calls = 0;
        const info = await api.initNetwork(join(root, "network"), "zyron-boot-liveness-init-testnet-1", { onProgress: () => { calls += 1; } });
        assert.equal(info.network, "testnet");
        // Heights 1-100 (below the v6 activation height 101) are produced offline once and committed by each of the 4 validators.
        assert.ok(calls >= 100 * 5, `progress reported ${calls} times`);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
