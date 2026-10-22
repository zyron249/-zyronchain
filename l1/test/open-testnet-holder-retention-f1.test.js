// R24-1048-I1-F1 (two Codex P2s on #1083, both fail safe before this change):
// (a) a holder whose validator data directory still has the temporary
//     `blocks.ndjson.prune-<pid>-<16hex>` file of an interrupted finalized-history
//     prune (storage.ts) is a testnet-created holder: it counts toward the bound
//     and can be pruned like any other;
// (b) an incoming directory that will not count toward the bound (it carries an
//     operator file below an allowed top-level entry) must not make move-aside
//     remove an older prunable holder earlier than needed.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const api = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
async function partialNetwork(dir) {
    await mkdir(join(dir, "keys"), { recursive: true });
    await mkdir(join(dir, "data-v1"), { recursive: true });
    await writeFile(join(dir, "genesis.json"), "{}");
    await writeFile(join(dir, "keys", "v1.json"), "{}");
    for (const file of ["blocks.ndjson", "metadata.json", "recovery-checkpoint.json"])
        await writeFile(join(dir, "data-v1", file), "");
}
async function holder(root, name, ms) {
    const path = join(root, `${name}.incomplete-${ms}-4242`);
    await partialNetwork(join(path, name));
    return path;
}
async function holders(root, name) {
    return (await readdir(root)).filter((entry) => entry.startsWith(`${name}.incomplete-`)).sort();
}
test("a holder with an interrupted-prune blocks.ndjson temporary counts toward the bound and is pruned", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-holder-f1-prune-"));
    try {
        const keep = api.MAX_INCOMPLETE_HOLDERS;
        const oldest = await holder(root, "net", 1_000);
        await writeFile(join(oldest, "net", "data-v1", `blocks.ndjson.prune-4242-${"a1".repeat(8)}`), "");
        const newer = [];
        for (let index = 1; index < keep; index += 1)
            newer.push(await holder(root, "net", 1_000 + index));
        await partialNetwork(join(root, "net"));
        await api.moveAsideIncompleteNetworkDir(join(root, "net"), { readMountPoints: async () => [], log: () => { } });
        assert.equal((await holders(root, "net")).length, keep);
        await assert.rejects(access(oldest), { code: "ENOENT" });
        for (const path of newer)
            await access(path);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("only the exact interrupted-prune temporary name is recognised", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-holder-f1-names-"));
    try {
        const keep = api.MAX_INCOMPLETE_HOLDERS;
        const lookalikes = [
            `blocks.ndjson.prune-0-${"a1".repeat(8)}`,
            `blocks.ndjson.prune-4242-${"a1".repeat(7)}`,
            `blocks.ndjson.prune-4242-${"A1".repeat(8)}`,
            `metadata.json.prune-4242-${"a1".repeat(8)}`,
            `blocks.ndjson.prune-4242-${"a1".repeat(8)}.bak`
        ];
        const protectedHolders = [];
        for (const [index, name] of lookalikes.entries()) {
            const path = await holder(root, "net", 100 + index);
            await writeFile(join(path, "net", "data-v1", name), "");
            protectedHolders.push(path);
        }
        for (let index = 0; index < keep + 1; index += 1)
            await holder(root, "net", 1_000 + index);
        await partialNetwork(join(root, "net"));
        await api.moveAsideIncompleteNetworkDir(join(root, "net"), { readMountPoints: async () => [], log: () => { } });
        for (const path of protectedHolders)
            await access(path);
        assert.equal((await holders(root, "net")).length, lookalikes.length + keep);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("an incoming directory that will not count toward the bound does not cost an older prunable holder", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-holder-f1-incoming-"));
    try {
        const keep = api.MAX_INCOMPLETE_HOLDERS;
        const old = [];
        for (let index = 0; index < keep; index += 1)
            old.push(await holder(root, "net", 1_000 + index));
        await partialNetwork(join(root, "net"));
        // An operator file below an allowed top-level entry: move-aside accepts the
        // directory, but the resulting holder is never pruned and never counted.
        await writeFile(join(root, "net", "data-v1", "operator-notes.txt"), "kept");
        const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { readMountPoints: async () => [], log: () => { } });
        await access(join(aside, "data-v1", "operator-notes.txt"));
        for (const path of old)
            await access(path);
        assert.equal((await holders(root, "net")).length, keep + 1);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
test("a counted incoming directory still keeps exactly the bound", { timeout: 60_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "zyron-holder-f1-counted-"));
    try {
        const keep = api.MAX_INCOMPLETE_HOLDERS;
        const old = [];
        for (let index = 0; index < keep; index += 1)
            old.push(await holder(root, "net", 1_000 + index));
        await partialNetwork(join(root, "net"));
        await api.moveAsideIncompleteNetworkDir(join(root, "net"), { readMountPoints: async () => [], log: () => { } });
        assert.equal((await holders(root, "net")).length, keep);
        await assert.rejects(access(old[0]), { code: "ENOENT" });
        for (const path of old.slice(1))
            await access(path);
    }
    finally {
        await rm(root, { recursive: true, force: true });
    }
});
