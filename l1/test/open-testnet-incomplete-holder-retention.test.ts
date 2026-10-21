// R24-1048-I1: moved-aside `<dir>.incomplete-<ms>-<pid>` holders had no
// retention bound, so a host that kept failing restores on the same disk
// accumulated one partial network per attempt. Move-aside now keeps the newest
// holders only, and prunes an older holder only when everything in it is
// something the open testnet itself creates. A holder with an operator file in
// it, a symlink, an unexpected name or an unexpected layout is never removed.
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);

// The layout a failed restore leaves behind: keys, genesis, and validator
// data directories holding the files a validator store writes.
async function partialNetwork(dir: string): Promise<void> {
  await mkdir(join(dir, "keys"), { recursive: true });
  await mkdir(join(dir, "data-v1", "consensus-state"), { recursive: true });
  await mkdir(join(dir, "data-v2"), { recursive: true });
  await writeFile(join(dir, "genesis.json"), "{}");
  await writeFile(join(dir, "keys", "v1.json"), "{}");
  for (const file of ["blocks.ndjson", "metadata.json", "state-v2.nodes.sqlite", "state-v2.nodes.sqlite-journal", "recovery-checkpoint.json", "state-v2.root.json.4242.1700000000000.tmp"]) await writeFile(join(dir, "data-v1", file), "");
  await writeFile(join(dir, "data-v1", "consensus-state", "H-1.json"), "{}");
  await writeFile(join(dir, "data-v2", "blocks.ndjson"), "");
}

async function holder(root: string, name: string, ms: number, suffix = ""): Promise<string> {
  const path = join(root, `${name}.incomplete-${ms}-4242${suffix}`);
  await partialNetwork(join(path, name));
  return path;
}

async function holders(root: string, name: string): Promise<string[]> {
  return (await readdir(root)).filter((entry) => entry.startsWith(`${name}.incomplete-`)).sort();
}

test("move-aside keeps a bounded number of testnet-created holders and prunes the oldest ones", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  assert.ok(api.MAX_INCOMPLETE_HOLDERS >= 2, "at least the new holder and one earlier attempt are kept");
  assert.ok(api.MAX_INCOMPLETE_HOLDERS <= 8, "the bound is small enough to matter on a small disk");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const old: string[] = [];
    for (let index = 0; index < keep + 3; index += 1) old.push(await holder(root, "net", 1_000_000 + index));
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"));
    assert.match(String(aside), /net\.incomplete-\d+-\d+\/net$/);
    await access(join(aside, "genesis.json"));
    const left = await holders(root, "net");
    assert.equal(left.length, keep, `expected ${keep} holders, found ${left.join(", ")}`);
    // The newest earlier holders and the one just created are the ones kept.
    for (const path of old.slice(old.length - (keep - 1))) await access(path);
    for (const path of old.slice(0, old.length - (keep - 1))) await assert.rejects(access(path), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning never removes a holder with an operator file, a symlink, an unexpected layout, or a foreign name", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-safe-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    // Protected old holders (oldest of all), each must survive.
    const withNote = await holder(root, "net", 10);
    await writeFile(join(withNote, "net", "keys", "operator-note.txt"), "kept");
    const withTopLevelFile = await holder(root, "net", 11);
    await writeFile(join(withTopLevelFile, "net", "notes.txt"), "kept");
    const withSibling = await holder(root, "net", 12);
    await writeFile(join(withSibling, "README"), "kept");
    const withLink = await holder(root, "net", 13);
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "kept");
    await symlink(outside, join(withLink, "net", "data-v1", "link"));
    const wrongInner = join(root, "net.incomplete-14-4242");
    await partialNetwork(join(wrongInner, "other"));
    const foreignName = join(root, "net.incomplete-old-copy");
    await partialNetwork(join(foreignName, "net"));
    const otherNetwork = join(root, "network2.incomplete-15-4242");
    await partialNetwork(join(otherNetwork, "network2"));
    // Prunable old holders beyond the bound.
    const prunable: string[] = [];
    for (let index = 0; index < keep + 2; index += 1) prunable.push(await holder(root, "net", 100 + index, index === 0 ? "-1" : ""));

    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"));
    await access(join(aside, "genesis.json"));

    for (const path of [withNote, withTopLevelFile, withSibling, withLink, wrongInner, foreignName, otherNetwork]) await access(path);
    await access(join(outside, "precious.txt"));
    // Only testnet-created holders count toward the bound: keep - 1 earlier
    // prunable ones survive next to the new holder; the oldest are removed.
    const survivors = prunable.slice(prunable.length - (keep - 1));
    for (const path of survivors) await access(path);
    for (const path of prunable.slice(0, prunable.length - (keep - 1))) await assert.rejects(access(path), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the holder just created is never pruned, even if older holders carry later timestamps (clock moved back)", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-clock-"));
  try {
    const future: string[] = [];
    for (let index = 0; index < api.MAX_INCOMPLETE_HOLDERS + 1; index += 1) future.push(await holder(root, "net", 9_000_000_000_000_000 + index));
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"));
    await access(join(aside, "genesis.json"));
    assert.equal((await holders(root, "net")).length, api.MAX_INCOMPLETE_HOLDERS);
    for (const path of future.slice(future.length - (api.MAX_INCOMPLETE_HOLDERS - 1))) await access(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pruning failure never fails the move-aside itself", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-fail-"));
  try {
    for (let index = 0; index < api.MAX_INCOMPLETE_HOLDERS + 1; index += 1) await holder(root, "net", 500 + index);
    await partialNetwork(join(root, "net"));
    const failures: string[] = [];
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), {
      removeHolder: async () => { throw Object.assign(new Error("EACCES: simulated"), { code: "EACCES" }); },
      log: (line: string) => failures.push(line)
    });
    await access(join(aside, "genesis.json"));
    assert.ok(failures.some((line) => /could not prune/.test(line)), failures.join("\n"));
    assert.equal((await holders(root, "net")).length, api.MAX_INCOMPLETE_HOLDERS + 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning never removes a holder with an operator file or a symlink inside a validator data directory", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-data-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const withDataNote = await holder(root, "net", 20);
    await writeFile(join(withDataNote, "net", "data-v1", "operator-note.txt"), "kept");
    const withStateNote = await holder(root, "net", 21);
    await writeFile(join(withStateNote, "net", "data-v1", "consensus-state", "notes.json"), "kept");
    const withDataDir = await holder(root, "net", 22);
    await mkdir(join(withDataDir, "net", "data-v2", "backup"));
    const withKnownLink = await holder(root, "net", 23);
    const outside = join(root, "outside.ndjson");
    await writeFile(outside, "kept");
    await rm(join(withKnownLink, "net", "data-v2", "blocks.ndjson"));
    await symlink(outside, join(withKnownLink, "net", "data-v2", "blocks.ndjson"));
    const prunable: string[] = [];
    for (let index = 0; index < keep + 1; index += 1) prunable.push(await holder(root, "net", 200 + index));
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    await access(join(aside, "genesis.json"));
    for (const path of [withDataNote, withStateNote, withDataDir, withKnownLink, outside]) await access(path);
    for (const path of prunable.slice(prunable.length - (keep - 1))) await access(path);
    for (const path of prunable.slice(0, prunable.length - (keep - 1))) await assert.rejects(access(path), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a holder that cannot be inspected is reported, not skipped silently", { timeout: 60_000, skip: process.getuid?.() === 0 ? "root can read any directory" : false }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-inspect-"));
  const locked: string[] = [];
  try {
    for (let index = 0; index < api.MAX_INCOMPLETE_HOLDERS + 1; index += 1) {
      const path = await holder(root, "net", 700 + index);
      await chmod(join(path, "net"), 0o000);
      locked.push(join(path, "net"));
    }
    await partialNetwork(join(root, "net"));
    const lines: string[] = [];
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: (line: string) => lines.push(line) });
    await access(join(aside, "genesis.json"));
    assert.ok(lines.some((line) => /could not inspect the moved-aside holder/.test(line)), lines.join("\n"));
  } finally {
    for (const path of locked) await chmod(path, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("old holders are pruned before the new holder is reserved, so a full disk can make room for it", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-enospc-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    for (let index = 0; index < keep + 2; index += 1) await holder(root, "net", 900 + index);
    await partialNetwork(join(root, "net"));
    // Simulated full disk: reserving a holder fails while keep or more old holders remain.
    let reservations = 0;
    const reserveHolder = async (path: string) => {
      reservations += 1;
      if ((await holders(root, "net")).length >= keep) throw Object.assign(new Error("ENOSPC: simulated"), { code: "ENOSPC" });
      await mkdir(path, { mode: 0o700 });
    };
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { reserveHolder, log: () => {} });
    await access(join(aside, "genesis.json"));
    assert.equal(reservations, 1, "the holder is reserved once, after the pre-prune");
    assert.equal((await holders(root, "net")).length, keep);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("when the pre-prune could not remove old holders, the later prune still never removes the holder just created", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-late-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    // Later timestamps than the new holder (clock moved back), so by name the new holder sorts oldest.
    for (let index = 0; index < keep + 1; index += 1) await holder(root, "net", 9_000_000_000_000_000 + index);
    await partialNetwork(join(root, "net"));
    let moved = false;
    const removeHolder = async (path: string) => {
      if (!moved) throw Object.assign(new Error("EBUSY: simulated"), { code: "EBUSY" });
      await rm(path, { recursive: true });
    };
    const reserveHolder = async (path: string) => { await mkdir(path, { mode: 0o700 }); moved = true; };
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { removeHolder, reserveHolder, log: () => {} });
    await access(join(aside, "genesis.json"));
    assert.equal((await holders(root, "net")).length, keep);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning never removes a holder with a JSON file in keys/ that the testnet does not write", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-keys-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const withKeyNote = await holder(root, "net", 30);
    await writeFile(join(withKeyNote, "net", "keys", "notes.json"), "kept");
    const withAllKeys = await holder(root, "net", 31);
    for (const name of ["v2", "v3", "v4", "oracle1", "oracle2", "oracle3", "founder", "faucet", "liquidity", "ecosystem"]) await writeFile(join(withAllKeys, "net", "keys", `${name}.json`), "{}");
    const prunable: string[] = [];
    for (let index = 0; index < keep; index += 1) prunable.push(await holder(root, "net", 300 + index));
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    await access(join(aside, "genesis.json"));
    await access(join(withKeyNote, "net", "keys", "notes.json"));
    // The holder with only testnet key names is prunable: it is the oldest prunable one.
    await assert.rejects(access(withAllKeys), { code: "ENOENT" });
    for (const path of prunable.slice(0, prunable.length - (keep - 1))) await assert.rejects(access(path), { code: "ENOENT" });
    for (const path of prunable.slice(prunable.length - (keep - 1))) await access(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the newest holder survives later restarts after the clock moved back (creation order persists across calls)", { timeout: 60_000 }, async (t) => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-rollback-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const dir = join(root, "net");
    let clock = 9_000_000_000_000;
    t.mock.method(Date, "now", () => clock);
    const created: string[] = [];
    // keep holders made while the clock ran ahead.
    for (let index = 0; index < keep; index += 1) {
      clock += 1;
      await partialNetwork(dir);
      created.push(String(await api.moveAsideIncompleteNetworkDir(dir, { log: () => {} })).slice(0, -"/net".length));
    }
    // The clock is corrected backwards; the next holder carries an earlier time but is the newest.
    clock = 1_000_000;
    await partialNetwork(dir);
    const afterRollback = String(await api.moveAsideIncompleteNetworkDir(dir, { log: () => {} })).slice(0, -"/net".length);
    // One more failed start-up: the holder from the previous call must not be the one pruned.
    clock += 1;
    await partialNetwork(dir);
    const latest = String(await api.moveAsideIncompleteNetworkDir(dir, { log: () => {} })).slice(0, -"/net".length);
    const left = await holders(root, "net");
    assert.equal(left.length, keep, left.join(", "));
    await access(afterRollback);
    await access(latest);
    // The oldest by creation are the ones removed.
    for (const path of created.slice(0, created.length - (keep - 2))) await assert.rejects(access(path), { code: "ENOENT" });
    for (const path of created.slice(created.length - (keep - 2))) await access(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning removes only the holder it inspected: contents added or a directory swapped in after inspection are kept", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-toctou-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const changed = await holder(root, "net", 40);
    const swapped = await holder(root, "net", 41);
    const prunable: string[] = [];
    for (let index = 0; index < keep; index += 1) prunable.push(await holder(root, "net", 400 + index));
    const inspected: string[] = [];
    // Test seam: runs after a holder was found prunable and before it is removed.
    const afterInspect = async (path: string) => {
      inspected.push(path);
      if (path === changed) await writeFile(join(changed, "net", "data-v1", "operator-note.txt"), "added after inspection");
      if (path === swapped) {
        await rm(swapped, { recursive: true });
        await mkdir(join(swapped, "net"), { recursive: true });
        await writeFile(join(swapped, "net", "genesis.json"), "foreign directory swapped in");
        await writeFile(join(swapped, "precious.txt"), "kept");
      }
    };
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { afterInspect, log: () => {} });
    await access(join(aside, "genesis.json"));
    assert.ok(inspected.includes(changed) && inspected.includes(swapped), `the seam saw ${inspected.join(", ")}`);
    await access(join(changed, "net", "data-v1", "operator-note.txt"));
    await access(join(swapped, "precious.txt"));
    await access(join(swapped, "net", "genesis.json"));
    // No private pruning leftovers remain next to the directory.
    assert.deepEqual((await readdir(root)).filter((entry) => !entry.startsWith("net.incomplete-") && entry !== "net"), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("after a clock rollback the new holder sorts after an existing holder of another process at the same time", { timeout: 60_000 }, async (t) => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-pid-"));
  try {
    const dir = join(root, "net");
    const later = 9_000_000_000_000;
    // Holders left by an earlier process (a higher pid) while the clock ran ahead.
    const earlier: string[] = [];
    for (let index = 0; index < api.MAX_INCOMPLETE_HOLDERS - 1; index += 1) {
      const path = join(root, `net.incomplete-${later - index}-99999999`);
      await partialNetwork(join(path, "net"));
      earlier.push(path);
    }
    let clock = 1_000_000;
    t.mock.method(Date, "now", () => clock);
    const created: string[] = [];
    for (let index = 0; index < api.MAX_INCOMPLETE_HOLDERS; index += 1) {
      clock += 1;
      await partialNetwork(dir);
      created.push(String(await api.moveAsideIncompleteNetworkDir(dir, { log: () => {} })).slice(0, -"/net".length));
    }
    // The holders this process created are the newest ones and all survive.
    for (const path of created) await access(path);
    for (const path of earlier) await assert.rejects(access(path), { code: "ENOENT" });
    assert.equal((await holders(root, "net")).length, api.MAX_INCOMPLETE_HOLDERS);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning keeps a holder rewritten in place or replaced by a look-alike after inspection", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-lookalike-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const rewritten = await holder(root, "net", 50);
    const replaced = await holder(root, "net", 51);
    for (let index = 0; index < keep; index += 1) await holder(root, "net", 500 + index);
    const afterInspect = async (path: string) => {
      if (path === rewritten) await writeFile(join(rewritten, "net", "data-v1", "blocks.ndjson"), "{\"operator\":\"appended after inspection\"}\n", { flag: "a" });
      if (path === replaced) {
        // Same layout and names, but a different directory than the one inspected.
        await rm(replaced, { recursive: true });
        await partialNetwork(join(replaced, "net"));
        await writeFile(join(replaced, "net", "genesis.json"), "{\"swapped\":true}");
      }
    };
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { afterInspect, log: () => {} });
    await access(join(aside, "genesis.json"));
    await access(join(rewritten, "net", "data-v1", "blocks.ndjson"));
    await access(join(replaced, "net", "genesis.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leftover suffixes count as testnet-created only on the files whose writers use them", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-leftover-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    // Suffixes no writer appends to these files: operator files, kept.
    const kept: string[] = [];
    for (const [index, file] of ["blocks.ndjson.corrupt-1-abcdef", "metadata.json.tmp-1-abcd", "blocks.ndjson.4242.tmp", "signing-journal.ndjson.4242.1700000000000.tmp"].entries()) {
      const path = await holder(root, "net", 60 + index);
      await writeFile(join(path, "net", "data-v1", file), "operator");
      kept.push(join(path, "net", "data-v1", file));
    }
    // Leftovers the store writers do leave behind: prunable.
    const generated = await holder(root, "net", 70);
    for (const file of ["state-v2.root.json.corrupt-1700000000000-0123456789ab", "recovery-checkpoint.json.tmp-42-0123456789abcdef", "metadata.json.4242.tmp", "state-v2.backend.json.4242.1700000000000.tmp"]) await writeFile(join(generated, "net", "data-v1", file), "");
    await writeFile(join(generated, "net", "data-v1", "consensus-state", "H-1.json.tmp-42-0123456789ab"), "");
    for (let index = 0; index < keep; index += 1) await holder(root, "net", 700 + index);
    await partialNetwork(join(root, "net"));
    await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    for (const path of kept) await access(path);
    await assert.rejects(access(generated), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("holder counters beyond the safe-integer range keep their order and never stall the reservation", { timeout: 60_000 }, async (t) => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-bigint-"));
  try {
    const later = 9_000_000_000_000;
    t.mock.method(Date, "now", () => 1_000_000);
    // A preserved (operator file) holder with a huge counter, and the name a Number-rounded counter would pick.
    const foreign = join(root, `net.incomplete-${later}-1-9007199254740993`);
    await partialNetwork(join(foreign, "net"));
    await writeFile(join(foreign, "net", "notes.txt"), "kept");
    await mkdir(join(root, `net.incomplete-${later}-${process.pid}-9007199254740992`));
    await partialNetwork(join(root, "net"));
    const result = await Promise.race([
      api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} }),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout("stalled"), 10_000).unref())
    ]);
    assert.notEqual(result, "stalled");
    assert.match(String(result), new RegExp(`net\\.incomplete-${later}-${process.pid}-9007199254740994/net$`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pruning never removes a holder that has a mount point inside it", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  // The mount table lists canonical paths (macOS tmpdir is under a /var symlink).
  const root = await realpath(await mkdtemp(join(tmpdir(), "zyron-holder-retention-mount-")));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const mounted = await holder(root, "net", 80);
    for (let index = 0; index < keep; index += 1) await holder(root, "net", 800 + index);
    await partialNetwork(join(root, "net"));
    // Test seam: the mount table as /proc/self/mountinfo would report it.
    const readMountPoints = async () => ["/", join(mounted, "net", "data-v1")];
    await api.moveAsideIncompleteNetworkDir(join(root, "net"), { readMountPoints, log: () => {} });
    await access(join(mounted, "net", "data-v1", "blocks.ndjson"));
    assert.deepEqual(api.parseMountInfoMountPoints("36 35 98:0 /mnt1 /mnt\\040with\\040space rw,noatime master:1 - ext3 /dev/root rw\n37 35 98:0 / / rw - ext4 /dev/sda1 rw\n"), ["/mnt with space", "/"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("holders stranded under a private pruning name by a crash are recovered on the next start", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-stranded-"));
  try {
    const prunable = join(root, ".net.incomplete-90-4242.pruning-4242-0123456789ab");
    await partialNetwork(join(prunable, "net"));
    const withNote = join(root, ".net.incomplete-91-4242.pruning-4242-0123456789ab");
    await partialNetwork(join(withNote, "net"));
    await writeFile(join(withNote, "net", "notes.txt"), "kept");
    const emptied = join(root, ".net.incomplete-92-4242.pruning-4242-0123456789ab");
    await mkdir(emptied);
    const unrelated = join(root, ".other.pruning-4242-0123456789ab");
    await mkdir(unrelated);
    await partialNetwork(join(root, "net"));
    await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    await assert.rejects(access(prunable), { code: "ENOENT" });
    await assert.rejects(access(emptied), { code: "ENOENT" });
    // An emptied one (the removal had got that far) is not brought back.
    await assert.rejects(access(join(root, "net.incomplete-92-4242")), { code: "ENOENT" });
    // A stranded holder that is not prunable goes back under its own name and is kept.
    await access(join(root, "net.incomplete-91-4242", "net", "notes.txt"));
    await access(unrelated);
    assert.deepEqual((await readdir(root)).filter((entry) => entry.includes(".pruning-")), [".other.pruning-4242-0123456789ab"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default mount table reader fails closed on Linux when mountinfo cannot be read", { timeout: 60_000, skip: process.platform !== "linux" ? "mountinfo is Linux only" : false }, async () => {
  assert.equal(typeof api.readMountPointsFromProc, "function");
  await assert.rejects(api.readMountPointsFromProc(join(tmpdir(), "zyron-no-such-mountinfo", "mountinfo")));
  assert.ok((await api.readMountPointsFromProc()).includes("/"));
});

test("only names the writers can create count as testnet-created (compaction leftovers, canonical consensus-state names, identity temporaries at the data root)", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-writers-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const identityTemp = `.node-identity.json.4242.${"ab".repeat(16)}.tmp`;
    const kept: string[] = [];
    for (const [index, file] of [
      join("data-v1", "consensus-state", "H-0.json"),
      join("data-v1", "consensus-state", "H-01.json"),
      join("data-v1", "consensus-state", "H-1-r-007.proposal.json"),
      join("data-v1", "consensus-state", "H-99999999999999999.json"),
      join("data-v1", "consensus-state", identityTemp),
      join("keys", identityTemp)
    ].entries()) {
      const path = await holder(root, "net", 30 + index);
      await writeFile(join(path, "net", file), "operator");
      kept.push(join(path, "net", file));
    }
    const generated = await holder(root, "net", 90);
    await writeFile(join(generated, "net", "data-v1", `signing-journal.ndjson.compact-4242-${"cd".repeat(8)}`), "");
    await writeFile(join(generated, "net", "data-v1", identityTemp), "");
    await writeFile(join(generated, "net", "data-v1", "consensus-state", "H-12-r-0.timeout.json"), "");
    for (let index = 0; index < keep; index += 1) await holder(root, "net", 900 + index);
    await partialNetwork(join(root, "net"));
    await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    for (const path of kept) await access(path);
    await assert.rejects(access(generated), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restoring a stranded holder is idempotent: an empty placeholder left by a crash does not block it", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-placeholder-"));
  try {
    const stranded = join(root, ".net.incomplete-95-4242.pruning-4242-0123456789ab");
    await partialNetwork(join(stranded, "net"));
    await writeFile(join(stranded, "net", "notes.txt"), "kept");
    await mkdir(join(root, "net.incomplete-95-4242"));
    await partialNetwork(join(root, "net"));
    await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    await access(join(root, "net.incomplete-95-4242", "net", "notes.txt"));
    await assert.rejects(access(stranded), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("holder names with fields this writer cannot produce do not steer the next name", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-fields-"));
  try {
    const huge = join(root, `net.incomplete-${"9".repeat(238)}-1`);
    await mkdir(huge);
    await writeFile(join(huge, "notes.txt"), "kept");
    await mkdir(join(root, "net.incomplete-0099-1"));
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    assert.match(String(aside), /net\.incomplete-[1-9]\d{0,15}-\d+\/net$/);
    await access(join(huge, "notes.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a holder counter at the top of its range advances the time instead of producing a name that is never counted", { timeout: 60_000 }, async (t) => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-maxcounter-"));
  try {
    const later = 9_000_000_000_000;
    t.mock.method(Date, "now", () => 1_000_000);
    const top = join(root, `net.incomplete-${later}-1-${"9".repeat(20)}`);
    await partialNetwork(join(top, "net"));
    await writeFile(join(top, "net", "notes.txt"), "kept");
    await partialNetwork(join(root, "net"));
    const aside = await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    assert.match(String(aside), new RegExp(`net\\.incomplete-${later + 1}-${process.pid}/net$`));
    await access(join(top, "net", "notes.txt"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leftover names with noncanonical numeric fields (leading zeros) are not testnet-created", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-canonical-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const kept: string[] = [];
    for (const [index, file] of [
      join("data-v1", "recovery-checkpoint.json.tmp-00042-0123456789abcdef"),
      join("data-v1", "recovery-checkpoint.json.tmp-0-0123456789abcdef"),
      join("data-v1", "metadata.json.04242.tmp"),
      join("data-v1", "state-v2.root.json.4242.01700000000000.tmp"),
      join("data-v1", "state-v2.root.json.corrupt-01700000000000-0123456789ab"),
      join("data-v1", `signing-journal.ndjson.compact-04242-${"cd".repeat(8)}`),
      join("data-v1", `.node-identity.json.04242.${"ab".repeat(16)}.tmp`),
      join("data-v1", "consensus-state", "H-1.json.tmp-042-0123456789ab")
    ].entries()) {
      const path = await holder(root, "net", 30 + index);
      await writeFile(join(path, "net", file), "operator");
      kept.push(join(path, "net", file));
    }
    for (let index = 0; index < keep; index += 1) await holder(root, "net", 900 + index);
    await partialNetwork(join(root, "net"));
    await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    for (const path of kept) await access(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite WAL sidecars are not testnet-created: every store database runs in DELETE journal mode", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-sidecars-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    const kept: string[] = [];
    for (const [index, file] of ["node-writer.lock.sqlite-wal", "signing-journal.lock.sqlite-shm", "state-v2.nodes.sqlite-wal", "state-v2.nodes.sqlite-shm.corrupt-1700000000000-0123456789ab"].entries()) {
      const path = await holder(root, "net", 30 + index);
      await writeFile(join(path, "net", "data-v1", file), "operator");
      kept.push(join(path, "net", "data-v1", file));
    }
    const generated = await holder(root, "net", 90);
    for (const file of ["node-writer.lock.sqlite-journal", "signing-journal.lock.sqlite", "state-v2.nodes.sqlite-journal.corrupt-1700000000000-0123456789ab"]) await writeFile(join(generated, "net", "data-v1", file), "");
    for (let index = 0; index < keep; index += 1) await holder(root, "net", 900 + index);
    await partialNetwork(join(root, "net"));
    await api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} });
    for (const path of kept) await access(path);
    await assert.rejects(access(generated), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failure while reading the existing holder order fails the move-aside instead of guessing the order", { timeout: 60_000, skip: process.getuid?.() === 0 ? "root can read any directory" : process.platform === "win32" ? "POSIX permissions" : false }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-orderfail-"));
  try {
    await partialNetwork(join(root, "net"));
    // Searchable and writable but not listable: holders can be created, but the order cannot be read.
    await chmod(root, 0o300);
    await assert.rejects(api.moveAsideIncompleteNetworkDir(join(root, "net"), { log: () => {} }));
    await chmod(root, 0o700);
    await access(join(root, "net", "genesis.json"));
    assert.deepEqual(await holders(root, "net"), []);
  } finally {
    await chmod(root, 0o700).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("holders whose private pruning name would exceed the name-length limit are still pruned and recovered", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-longname-"));
  try {
    const keep = api.MAX_INCOMPLETE_HOLDERS;
    // A 215-byte network name: holder names fit in 255 bytes, ".<holder>.pruning-<pid>-<hex>" would not.
    const name = "n".repeat(215);
    const old: string[] = [];
    for (let index = 0; index < keep + 2; index += 1) old.push(await holder(root, name, 1_000_000 + index));
    await partialNetwork(join(root, name));
    await api.moveAsideIncompleteNetworkDir(join(root, name), { log: () => {} });
    assert.equal((await holders(root, name)).length, keep);
    for (const path of old.slice(0, old.length - (keep - 1))) await assert.rejects(access(path), { code: "ENOENT" });
    assert.deepEqual((await readdir(root)).filter((entry) => entry.includes("pruning")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a holder stranded under the short private pruning name is recovered only when it belongs to this network", { timeout: 60_000 }, async () => {
  assert.equal(typeof api.MAX_INCOMPLETE_HOLDERS, "number");
  const root = await mkdtemp(join(tmpdir(), "zyron-holder-retention-shortstranded-"));
  try {
    const name = "n".repeat(215);
    const prunable = join(root, ".pruning-4242-0123456789ab.incomplete-90-4242");
    await partialNetwork(join(prunable, name));
    const withNote = join(root, ".pruning-4242-0123456789ac.incomplete-91-4242");
    await partialNetwork(join(withNote, name));
    await writeFile(join(withNote, name, "notes.txt"), "kept");
    const foreign = join(root, ".pruning-4242-0123456789ad.incomplete-92-4242");
    await partialNetwork(join(foreign, "other"));
    await partialNetwork(join(root, name));
    await api.moveAsideIncompleteNetworkDir(join(root, name), { log: () => {} });
    await assert.rejects(access(prunable), { code: "ENOENT" });
    await access(join(root, `${name}.incomplete-91-4242`, name, "notes.txt"));
    await access(join(foreign, "other", "genesis.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
