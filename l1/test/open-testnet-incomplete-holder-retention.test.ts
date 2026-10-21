// R24-1048-I1: moved-aside `<dir>.incomplete-<ms>-<pid>` holders had no
// retention bound, so a host that kept failing restores on the same disk
// accumulated one partial network per attempt. Move-aside now keeps the newest
// holders only, and prunes an older holder only when everything in it is
// something the open testnet itself creates. A holder with an operator file in
// it, a symlink, an unexpected name or an unexpected layout is never removed.
import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
