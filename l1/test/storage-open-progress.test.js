// R26-1048-L1 (Codex on #1048, tracked as a Low): ChainStore.open scans the
// whole finalized block log (line scan below a recovery checkpoint, full
// replay without one) and reports nothing while it runs. The open-testnet
// restore opens one copy per validator during the boot phase, whose liveness
// check fails after minutes without progress, so a long enough log would make
// a healthy, progressing restore look stalled. ChainStore.open must report
// every stored block record it reads.
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ChainStore } = await import(pathToFileURL(join(l1Root, "dist", "src", "storage.js")).href);
test("ChainStore.open reports every stored block record it reads, with and without a recovery checkpoint", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-open-progress-"));
    try {
        const source = join(root, "source");
        await api.initNetwork(source, "zyron-open-progress-testnet-1");
        const genesis = JSON.parse(await readFile(join(source, "genesis.json"), "utf8"));
        const height = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).trim().split("\n").length;
        const seed = await ChainStore.open(genesis, join(source, "data-v1"));
        await seed.writeRecoveryCheckpoint();
        for (const withCheckpoint of [true, false]) {
            const dir = join(root, withCheckpoint ? "with-checkpoint" : "full-replay");
            await mkdir(dir);
            const files = withCheckpoint ? ["metadata.json", "blocks.ndjson", "recovery-checkpoint.json"] : ["metadata.json", "blocks.ndjson"];
            for (const file of files)
                await copyFile(join(source, "data-v1", file), join(dir, file));
            let records = 0;
            const store = await ChainStore.open(genesis, dir, { onBlockRecord: () => { records += 1; } });
            assert.equal(store.chain.height, height);
            assert.ok(records >= height, `${withCheckpoint ? "checkpoint" : "full replay"} open reported ${records} records for ${height} blocks`);
        }
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
// R31-1060-L1 (OpenClaw Round 31): the hook counts records read, not distinct
// records. A checkpoint that does not match the log is rejected and the open
// falls back to a full replay; that replay must keep reporting progress too.
test("ChainStore.open keeps reporting progress when it falls back from a rejected checkpoint to a full replay", { timeout: 240_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-open-progress-fallback-"));
    try {
        const source = join(root, "source");
        await api.initNetwork(source, "zyron-open-progress-fallback-testnet-1");
        const genesis = JSON.parse(await readFile(join(source, "genesis.json"), "utf8"));
        const height = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).trim().split("\n").length;
        const seed = await ChainStore.open(genesis, join(source, "data-v1"));
        await seed.writeRecoveryCheckpoint();
        const dir = join(root, "fallback");
        await mkdir(dir);
        for (const file of ["metadata.json", "blocks.ndjson", "recovery-checkpoint.json"])
            await copyFile(join(source, "data-v1", file), join(dir, file));
        // A checkpoint whose recorded log length no longer matches the log.
        const checkpointPath = join(dir, "recovery-checkpoint.json");
        const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"));
        checkpoint.blockFileBytes += 1;
        await writeFile(checkpointPath, `${JSON.stringify(checkpoint)}\n`);
        let records = 0;
        const store = await ChainStore.open(genesis, dir, { onBlockRecord: () => { records += 1; } });
        assert.equal(store.chain.height, height, "the fallback full replay restores the same chain");
        assert.ok(records > height, `fallback open reported ${records} reads for ${height} blocks: the full replay after the rejected checkpoint reported no progress`);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
