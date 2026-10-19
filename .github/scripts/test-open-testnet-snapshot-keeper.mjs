#!/usr/bin/env node
// Tests for the open-testnet snapshot keeper (.github/scripts/open-testnet-snapshot-keeper.mjs)
// and static policy checks for its scheduled workflow.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  GITHUB_CALL_TIMEOUT_MS, RENAME_RETRY_DELAYS_MS, cancellableSleep, SNAPSHOT_HEADER, UNLABELED_MARGIN_MS, GenesisMismatchError, createGitHub, decideReplace, exitCodeFor, fetchSnapshot, formatLabel,
  keeperAssetName, parseKeeperAssetName, parseLabel, perGenesisName, publishAsset, publishCycle, readCapped, repairAndCleanup, runKeeper, validateSnapshot
} from "./open-testnet-snapshot-keeper.mjs";

const GENESIS = "9ad75d777141de46df1fb008298a4d8a92fbce0a9c96aaf26ecf69474b7db8eb";
const OTHER = "822cf008".padEnd(64, "0");
const T0 = Date.parse("2026-10-19T05:00:00Z");
const sealed = (size = 200) => Buffer.concat([Buffer.from(SNAPSHOT_HEADER), Buffer.alloc(size, 7)]);
const headersOf = (map) => new Headers(map);

// Virtual clock: sleep() registers a timer; run() fires the earliest timer
// whenever every task is idle, so concurrent loops see consistent time.
function virtualTime(start = T0) {
  let clock = start;
  const timers = [];
  const sleep = (ms) => new Promise((resolve) => timers.push({ at: clock + ms, resolve }));
  async function run(promise) {
    let done = false;
    let idle = 0;
    const result = promise.finally(() => { done = true; });
    while (!done) {
      for (let i = 0; i < 20 && !done; i += 1) await new Promise((resolve) => setImmediate(resolve));
      if (done) continue;
      if (!timers.length) {
        if (++idle > 500) throw new Error("virtual time stalled: the task waits on neither a timer nor I/O");
        continue;
      }
      idle = 0;
      timers.sort((a, b) => a.at - b.at);
      const next = timers.shift();
      clock = Math.max(clock, next.at);
      next.resolve();
    }
    return result;
  }
  return { now: () => clock, sleep, run };
}

// In-memory release with GitHub's asset semantics: unique names, delete by id, rename by id.
function fakeGitHub({ assets = [], now = () => T0 } = {}) {
  let nextId = 100;
  const state = { assets: assets.map((asset) => ({ state: "uploaded", size: 1000, ...asset })), calls: [], hooks: {} };
  const github = {
    async release(tag) { state.calls.push(["release", tag]); await state.hooks.release?.(state); return { id: 1, assets: state.assets.map((asset) => ({ ...asset })) }; },
    async upload(releaseId, name, label, bytes) {
      state.calls.push(["upload", name, label]);
      if (state.assets.some((asset) => asset.name === name)) { const error = new Error("exists"); error.status = 422; throw error; }
      const asset = { id: nextId++, name, label, state: "uploaded", size: bytes.length, updated_at: new Date(now()).toISOString(), bytes };
      state.assets.push(asset);
      return { ...asset };
    },
    async remove(id) {
      state.calls.push(["remove", id]);
      const index = state.assets.findIndex((asset) => asset.id === id);
      if (index < 0) return false;
      state.assets.splice(index, 1);
      return true;
    },
    async rename(id, name, label) {
      state.calls.push(["rename", id, name]);
      await state.hooks.rename?.(state);
      if (state.assets.some((asset) => asset.name === name && asset.id !== id)) { const error = new Error("exists"); error.status = 422; throw error; }
      const asset = state.assets.find((entry) => entry.id === id);
      Object.assign(asset, { name, label });
      return { ...asset };
    }
  };
  return { github, state };
}

test("labels round-trip and reject anything else", () => {
  assert.deepEqual(parseLabel(formatLabel(2145, GENESIS)), { height: 2145, genesis: GENESIS });
  for (const bad of ["", null, undefined, "state snapshot height=0 genesis=" + GENESIS, "state snapshot height=12 genesis=" + GENESIS.slice(1), `x ${formatLabel(5, GENESIS)}`, "state snapshot height=99999999999999999 genesis=" + GENESIS]) {
    assert.equal(parseLabel(bad), null, String(bad));
  }
  assert.equal(perGenesisName(GENESIS), "state-9ad75d777141.enc");
  assert.equal(keeperAssetName("next", "state.enc", T0, "0a1b2c3d"), `next-${T0}-0a1b2c3d.state.enc`);
  assert.deepEqual(parseKeeperAssetName(keeperAssetName("prev", "state-9ad75d777141.enc", T0, "0a1b2c3d")), { kind: "prev", ms: T0, finalName: "state-9ad75d777141.enc" });
  for (const name of ["state.enc", "state-9ad75d777141.enc", `next-${T0}-0a1b2c3d.other.enc`, `old-${T0}-0a1b2c3d.state.enc`, `next-${T0}-0A1B2C3D.state.enc`]) assert.equal(parseKeeperAssetName(name), null, name);
});

test("validateSnapshot accepts a sealed snapshot of the expected genesis only", () => {
  const bytes = sealed();
  const ok = { status: 200, headers: headersOf({ "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS, "content-length": String(bytes.length) }), bytes };
  assert.deepEqual(validateSnapshot(ok, GENESIS), { height: 2150, genesis: GENESIS });
  assert.throws(() => validateSnapshot({ ...ok, headers: headersOf({ "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": OTHER }) }, GENESIS), GenesisMismatchError);
  assert.throws(() => validateSnapshot({ ...ok, status: 503 }, GENESIS), /HTTP 503/);
  for (const height of ["", "0", "-1", "12a", "1e3", "99999999999999999"]) {
    assert.throws(() => validateSnapshot({ ...ok, headers: headersOf({ "x-zyron-snapshot-height": height, "x-zyron-genesis-hash": GENESIS }) }, GENESIS), /height/, height);
  }
  assert.throws(() => validateSnapshot({ ...ok, headers: headersOf({ "x-zyron-snapshot-height": "5", "x-zyron-genesis-hash": "abc" }) }, GENESIS), /genesis header/);
  assert.throws(() => validateSnapshot({ ...ok, headers: headersOf({ "x-zyron-snapshot-height": "5", "x-zyron-genesis-hash": GENESIS, "content-length": String(bytes.length + 1) }) }, GENESIS), /truncated/);
  assert.throws(() => validateSnapshot({ ...ok, bytes: Buffer.from("<html>sleeping</html>".padEnd(400, " ")), headers: headersOf({ "x-zyron-snapshot-height": "5", "x-zyron-genesis-hash": GENESIS }) }, GENESIS), /not an open-testnet/);
  assert.throws(() => validateSnapshot({ ...ok, bytes: Buffer.from(SNAPSHOT_HEADER), headers: headersOf({ "x-zyron-snapshot-height": "5", "x-zyron-genesis-hash": GENESIS }) }, GENESIS), /size/);
});

test("decideReplace keeps the published height monotonic", () => {
  const snapshot = { height: 2150, genesis: GENESIS };
  const base = { snapshot, expectedGenesis: GENESIS, requestStartedMs: T0 };
  assert.equal(decideReplace({ ...base, asset: null }).publish, true);
  assert.equal(decideReplace({ ...base, asset: { label: formatLabel(2149, GENESIS) } }).publish, true);
  assert.equal(decideReplace({ ...base, asset: { label: formatLabel(2150, GENESIS) } }).publish, false);
  assert.equal(decideReplace({ ...base, asset: { label: formatLabel(2151, GENESIS) } }).publish, false);
  assert.equal(decideReplace({ ...base, asset: { label: formatLabel(10, OTHER) } }).publish, false, "an asset labeled for another genesis is never replaced");
  assert.equal(decideReplace({ ...base, snapshot: { height: 9999, genesis: OTHER }, asset: null }).publish, false, "a snapshot of another genesis is never published");
  // Unlabeled assets (legacy keeper): only snapshots requested well after the asset was written.
  const at = (ms) => ({ label: "", updated_at: new Date(ms).toISOString() });
  assert.equal(decideReplace({ ...base, asset: at(T0 - UNLABELED_MARGIN_MS - 1000) }).publish, true);
  assert.equal(decideReplace({ ...base, asset: at(T0 - UNLABELED_MARGIN_MS) }).publish, false);
  assert.equal(decideReplace({ ...base, asset: at(T0 - 30_000) }).publish, false);
  assert.equal(decideReplace({ ...base, asset: at(T0 + 60_000) }).publish, false);
  assert.equal(decideReplace({ ...base, asset: { label: "", updated_at: "garbage" } }).publish, false);
});

test("publishAsset uploads under a temporary name and swaps only after the upload exists", async () => {
  const old = { id: 7, name: "state.enc", label: formatLabel(2100, GENESIS), updated_at: new Date(T0 - 600_000).toISOString() };
  const { github, state } = fakeGitHub({ assets: [old] });
  const lines = [];
  const result = await publishAsset({ github, tag: "open-testnet-state", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log: (line) => lines.push(line) });
  assert.equal(result.published, true);
  const kinds = state.calls.map((call) => call[0]);
  assert.deepEqual(kinds, ["release", "upload", "release", "rename", "rename"]);
  assert.match(state.calls[1][1], /^next-\d{13}-[0-9a-f]{8}\.state\.enc$/, "the first upload never uses the restore name");
  assert.equal(state.calls[3][1], 7);
  assert.match(state.calls[3][2], /^prev-\d{13}-[0-9a-f]{8}\.state\.enc$/, "the old asset is moved aside, not deleted");
  // The moved-aside asset stays as a backup (repairAndCleanup ages it out later).
  assert.deepEqual(state.assets.map((asset) => [asset.id, /^prev-/.test(asset.name) ? "prev" : asset.name, asset.label]).sort((a, b) => a[0] - b[0]),
    [[7, "prev", formatLabel(2100, GENESIS)], [100, "state.enc", formatLabel(2150, GENESIS)]]);
  assert.ok(lines.some((line) => line.includes("height 2150")));
});

test("publishAsset does nothing when the published height is not lower", async () => {
  const old = { id: 7, name: "state.enc", label: formatLabel(2150, GENESIS) };
  const { github, state } = fakeGitHub({ assets: [old] });
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {} });
  assert.equal(result.published, false);
  assert.deepEqual(state.calls.map((call) => call[0]), ["release"]);
  assert.equal(state.assets[0].id, 7);
});

test("publishAsset re-checks before the swap and keeps a higher asset another keeper published meanwhile", async () => {
  const old = { id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) };
  const { github, state } = fakeGitHub({ assets: [old] });
  let releases = 0;
  state.hooks.release = (s) => {
    releases += 1;
    if (releases === 2) { s.assets = s.assets.filter((asset) => asset.id !== 7); s.assets.push({ id: 50, name: "state.enc", label: formatLabel(2160, GENESIS), state: "uploaded", size: 1000 }); }
  };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {} });
  assert.equal(result.published, false);
  assert.match(result.reason, /another keeper published first/);
  assert.ok(!state.calls.some((call) => call[0] === "rename"), "no swap is attempted against a newer asset");
  assert.deepEqual(state.assets.map((asset) => [asset.id, asset.name]), [[50, "state.enc"]], "the newer asset stays and the temporary upload is removed");
});

test("publishAsset treats a fresh unlabeled asset from the legacy keeper as possibly newer", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: "", updated_at: new Date(T0 - 10_000).toISOString() }] });
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {} });
  assert.equal(result.published, false);
  assert.equal(state.assets.length, 1);
  assert.equal(state.assets[0].id, 7);
});

test("publishAsset loses a concurrent same-name upload cleanly and never leaves the name missing", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  // Their asset is complete (GitHub reports every asset with a state and a size).
  state.hooks.rename = (s) => { if (!s.assets.some((asset) => asset.name === "state.enc")) s.assets.push({ id: 60, name: "state.enc", label: "", state: "uploaded", size: 1000 }); };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {} });
  assert.equal(result.published, false);
  assert.ok(state.assets.some((asset) => asset.id === 60 && asset.name === "state.enc"), "their asset keeps the name");
  assert.ok(!state.assets.some((asset) => /^next-/.test(asset.name)), "our upload is removed");
  assert.ok(state.assets.some((asset) => asset.id === 7 && /^prev-/.test(asset.name)), "the old copy is kept aside for cleanup");
});

test("publishAsset keeps its upload for repair when no asset holds the name and the final rename fails", async () => {
  // Nothing was swapped (no previous asset); the upload is the only complete
  // copy, so it is never deleted and the next repair installs it.
  const { github, state } = fakeGitHub({ assets: [] });
  const rename = github.rename;
  let broken = true;
  github.rename = async (id, name, label) => { if (broken) { state.calls.push(["rename", id, name]); const error = new Error("boom"); error.status = 500; throw error; } return rename(id, name, label); };
  const warnings = [];
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 5, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} }), /boom/);
  assert.deepEqual(state.assets.map((asset) => [/^next-\d{13}-[0-9a-f]{8}\.state\.enc$/.test(asset.name), parseLabel(asset.label)?.height]), [[true, 5]], "only the upload exists, under its temporary name");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /keeping the upload/.test(line)));
  broken = false;
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0 + 60_000, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 5);
});

test("a failed final rename puts the old asset back and never leaves the restore name missing", async () => {
  const old = { id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) };
  const { github, state } = fakeGitHub({ assets: [old] });
  const rename = github.rename;
  let finalAttempts = 0;
  github.rename = async (id, name, label) => {
    if (id !== 7 && name === "state.enc") { finalAttempts += 1; const error = new Error("timeout"); error.status = 502; throw error; }
    return rename(id, name, label);
  };
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, sleep: async () => {} }), /timeout/);
  assert.deepEqual(state.assets.map((asset) => [asset.id, asset.name, asset.label]), [[7, "state.enc", formatLabel(2100, GENESIS)]]);
  assert.equal(finalAttempts, 3, "the final rename is retried before giving up");
});

test("when the old asset cannot be put back either, both copies stay and the next cycle repairs the name", async () => {
  const old = { id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) };
  const { github, state } = fakeGitHub({ assets: [old] });
  const rename = github.rename;
  let broken = true;
  github.rename = async (id, name, label) => {
    if (broken && name === "state.enc") { const error = new Error("outage"); error.status = 503; throw error; }
    return rename(id, name, label);
  };
  const warnings = [];
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} }), /outage/);
  assert.equal(state.assets.length, 2, "neither copy is deleted");
  assert.ok(state.assets.every((asset) => /^(next|prev)-/.test(asset.name)));
  assert.ok(warnings.some((line) => /keeping both copies/.test(line)));
  broken = false;
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0 + 60_000, log() {}, warn() {}, sleep: async () => {} });
  const restored = state.assets.find((asset) => asset.name === "state.enc");
  assert.equal(parseLabel(restored.label).height, 2150, "the highest labeled copy of the expected genesis is restored");
  assert.equal(state.assets.length, 2, "the other copy is kept");
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0 + 31 * 60_000, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(state.assets.length, 2, "the only remaining copy is kept as a backup even when stale");
});

test("publishAsset never deletes the moved-aside asset after a successful swap", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  github.remove = async () => { throw new Error("must not delete"); };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, true);
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc").label).height, 2150);
  // Another keeper's delete-then-upload may remove the new state.enc right
  // after the swap; the moved-aside copy is what the next cycle repairs from.
  assert.match(state.assets.find((asset) => asset.id === 7).name, /^prev-\d{13}-[0-9a-f]{8}\.state\.enc$/);
});

test("an aside rename that GitHub applied but whose response was lost does not delete the replacement", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  github.rename = async (id, name, label) => {
    const result = await rename(id, name, label);
    if (id === 7 && /^prev-/.test(name)) { const error = new Error("socket hang up"); error.status = 502; throw error; }
    return result;
  };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, true, "the listing shows the aside rename happened, so the swap completes");
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label).height, 2150);
  assert.match(state.assets.find((asset) => asset.id === 7).name, /^prev-/);
  assert.ok(!state.calls.some((call) => call[0] === "remove"), "the replacement upload is never deleted");
});

test("an aside rename that failed leaves state.enc untouched; an unverifiable one keeps the upload for repair", async () => {
  {
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
    github.rename = async () => { const error = new Error("boom"); error.status = 500; throw error; };
    await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} }), /boom/);
    assert.deepEqual(state.assets.map((asset) => [asset.id, asset.name]), [[7, "state.enc"]], "the listing shows the rename did not happen: the upload is dropped");
  }
  {
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
    const rename = github.rename;
    github.rename = async (id, name, label) => { await rename(id, name, label); const error = new Error("socket hang up"); error.status = 502; throw error; };
    let listings = 0;
    state.hooks.release = () => { listings += 1; if (listings >= 3) throw new Error("listing unavailable"); };
    const warnings = [];
    await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} }), /socket hang up/);
    assert.ok(state.assets.some((asset) => /^next-/.test(asset.name) && parseLabel(asset.label)?.height === 2150), "the upload is kept when the outcome cannot be verified");
    assert.ok(warnings.some((line) => /keeping the upload/.test(line)));
  }
});

test("an aside rename whose old asset vanished (deleted by another keeper) installs the upload at once", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  github.rename = async (id, name, label) => {
    if (id === 7) { state.calls.push(["rename", id, name]); state.assets = state.assets.filter((asset) => asset.id !== 7); const error = new Error("Not Found"); error.status = 404; throw error; }
    return rename(id, name, label);
  };
  const warnings = [];
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} });
  assert.equal(result.published, true);
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 2150, "the name is not left missing until the next cycle");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /vanished|deleted/.test(line)));
});

test("when the old asset vanished and the final rename then fails, the upload is kept for repair", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  let failing = true;
  github.rename = async (id, name, label) => {
    if (id === 7) { state.calls.push(["rename", id, name]); state.assets = state.assets.filter((asset) => asset.id !== 7); const error = new Error("Not Found"); error.status = 404; throw error; }
    if (failing && name === "state.enc") { state.calls.push(["rename", id, name]); const error = new Error("socket hang up"); error.status = 502; throw error; }
    return rename(id, name, label);
  };
  const warnings = [];
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} }), /socket hang up/);
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name) && parseLabel(asset.label)?.height === 2150), "the upload stays as a keeper copy");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /keeping the upload/.test(line)));
  failing = false;
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 2150);
});

test("an ambiguous aside rename whose old asset now has another name is not taken as the moved-aside backup", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  // GitHub applied a different rename of the old asset (another client), then the response was lost.
  github.rename = async (id, name, label) => {
    if (id === 7 && /^prev-/.test(name)) { await rename(id, "renamed-by-someone-else.enc", label); const error = new Error("socket hang up"); error.status = 502; throw error; }
    if (id !== 7 && name === "state.enc") { state.calls.push(["rename", id, name]); const error = new Error("socket hang up"); error.status = 502; throw error; }
    return rename(id, name, label);
  };
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} }), /socket hang up/);
  assert.equal(state.assets.find((asset) => asset.id === 7)?.name, "renamed-by-someone-else.enc", "an asset that is not this keeper's aside copy is never renamed back");
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name)), "the upload is kept for repair");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
});

test("a final rename that GitHub applied but whose response was lost keeps the new asset (no previous asset)", async () => {
  const { github, state } = fakeGitHub({ assets: [] });
  const rename = github.rename;
  github.rename = async (id, name, label) => { const result = await rename(id, name, label); if (name === "state.enc") { const error = new Error("socket hang up"); error.status = 502; throw error; } return result; };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 5, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, true);
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 5);
  assert.ok(!state.calls.some((call) => call[0] === "remove"), "the now-canonical asset is never deleted");
});

test("a final rename that GitHub applied but whose response was lost keeps the new asset and the backup", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  github.rename = async (id, name, label) => { const result = await rename(id, name, label); if (id !== 7 && name === "state.enc") { const error = new Error("socket hang up"); error.status = 502; throw error; } return result; };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, true);
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc").label).height, 2150);
  assert.match(state.assets.find((asset) => asset.id === 7).name, /^prev-/);
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
});

test("a failed final rename whose outcome cannot be verified deletes nothing", async () => {
  const { github, state } = fakeGitHub({ assets: [] });
  github.rename = async () => { const error = new Error("socket hang up"); error.status = 502; throw error; };
  let listings = 0;
  state.hooks.release = () => { listings += 1; if (listings >= 3) throw new Error("listing unavailable"); };
  const warnings = [];
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 5, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} }), /socket hang up/);
  assert.equal(state.assets.length, 1, "the upload is kept for repair");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /could not verify/.test(line)));
});

test("a failed final rename whose outcome cannot be verified keeps the upload and the moved-aside copy", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  github.rename = async (id, name, label) => { if (id !== 7 && name === "state.enc") { state.calls.push(["rename", id, name]); const error = new Error("socket hang up"); error.status = 502; throw error; } return rename(id, name, label); };
  let listings = 0;
  state.hooks.release = () => { listings += 1; if (listings >= 3) throw new Error("listing unavailable"); };
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} }), /socket hang up/);
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name)) && state.assets.some((asset) => asset.id === 7 && /^prev-/.test(asset.name)), "nothing is renamed back or deleted");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
});

test("a failed final rename is not taken as published when the listing shows another asset under the name", async () => {
  const { github, state } = fakeGitHub({ assets: [] });
  github.rename = async (id, name) => {
    state.calls.push(["rename", id, name]);
    if (!state.assets.some((asset) => asset.id === 60)) state.assets.push({ id: 60, name, label: formatLabel(2200, GENESIS), state: "uploaded", size: 1000 });
    const error = new Error("socket hang up"); error.status = 502; throw error;
  };
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 5, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} }), /socket hang up/);
  assert.deepEqual(state.assets.map((asset) => [asset.id, asset.name]), [[60, "state.enc"]], "the other asset stays and the upload is removed");
});

// The legacy keeper deletes state.enc and uploads its replacement: while that
// upload runs, GitHub lists it under the name in the `starter` state.
// (The aside rename is retried, so this may run more than once; it starts one upload.)
const legacyUploadStarts = (s) => { if (!s.assets.some((asset) => asset.id === 60)) s.assets.push({ id: 60, name: "state.enc", label: "", state: "starter", size: 0, updated_at: new Date(T0).toISOString() }); };

test("a final rename that collides with an in-progress upload keeps the replacement for repair (old asset vanished, no backup)", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  github.rename = async (id, name, label) => {
    if (id === 7) { state.calls.push(["rename", id, name]); state.assets = state.assets.filter((asset) => asset.id !== 7); legacyUploadStarts(state); const error = new Error("Not Found"); error.status = 404; throw error; }
    return rename(id, name, label);
  };
  const warnings = [];
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} });
  assert.equal(result.published, false);
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name) && parseLabel(asset.label)?.height === 2150), "the complete upload is the only usable copy and is kept");
  assert.ok(!state.calls.some((call) => call[0] === "remove"), "nothing is deleted while the colliding asset is incomplete");
  assert.ok(warnings.some((line) => /incomplete|in progress/.test(line)));
  // The other upload never completes: once it counts as abandoned, repair installs the kept upload.
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0 + 16 * 60_000, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 2150);
});

test("a final rename that collides with an in-progress upload keeps the replacement (after a completed aside rename)", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const rename = github.rename;
  github.rename = async (id, name, label) => {
    if (id !== 7 && name === "state.enc" && !state.assets.some((asset) => asset.id === 60)) legacyUploadStarts(state);
    return rename(id, name, label);
  };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, false);
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name) && parseLabel(asset.label)?.height === 2150), "the upload is kept");
  assert.ok(state.assets.some((asset) => asset.id === 7 && /^prev-/.test(asset.name)), "the moved-aside copy is kept too");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
});

test("a final rename collision whose holder cannot be checked keeps the replacement", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  state.hooks.rename = (s) => { if (!s.assets.some((asset) => asset.name === "state.enc")) s.assets.push({ id: 60, name: "state.enc", label: "", state: "uploaded", size: 1000 }); };
  let listings = 0;
  state.hooks.release = () => { listings += 1; if (listings >= 3) throw new Error("listing unavailable"); };
  const warnings = [];
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} });
  assert.equal(result.published, false);
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name)), "the upload is kept when the colliding asset cannot be confirmed complete");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /could not verify/.test(line)));
});

test("the pre-swap re-check keeps the upload when the asset now under the name is still being uploaded", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  let releases = 0;
  state.hooks.release = (s) => { releases += 1; if (releases === 2) { s.assets = s.assets.filter((asset) => asset.id !== 7); legacyUploadStarts(s); } };
  const warnings = [];
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} });
  assert.equal(result.published, false);
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name) && parseLabel(asset.label)?.height === 2150), "the complete upload is kept while the other upload may still fail");
  assert.ok(!state.calls.some((call) => call[0] === "remove" || call[0] === "rename"));
  assert.ok(warnings.some((line) => /incomplete|in progress/.test(line)));
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0 + 16 * 60_000, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 2150, "repair installs it once the other upload is abandoned");
});

test("a failed pre-swap listing keeps the upload for repair", async () => {
  const { github, state } = fakeGitHub({ assets: [] });
  let releases = 0;
  state.hooks.release = () => { releases += 1; if (releases === 2) throw new Error("listing unavailable"); };
  const warnings = [];
  await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} }), /listing unavailable/);
  assert.ok(state.assets.some((asset) => /^next-/.test(asset.name) && parseLabel(asset.label)?.height === 2150), "the only complete snapshot is not deleted");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /keeping the upload/.test(line)));
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0 + 60_000, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 2150);
});

test("repair verifies an ambiguous aside rename of an incomplete canonical asset before giving up", async () => {
  const backup = { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 5 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) };
  {
    // GitHub applied the aside rename and every response was lost: the backup is installed in the same cycle.
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: "", size: 12 }, { ...backup }] });
    const rename = github.rename;
    github.rename = async (id, name, label) => { const result = await rename(id, name, label); if (id === 7) { const error = new Error("socket hang up"); error.status = 502; throw error; } return result; };
    await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
    assert.equal(state.assets.find((asset) => asset.name === "state.enc")?.id, 3, "the backup is in place");
    assert.match(state.assets.find((asset) => asset.id === 7).name, /^prev-/);
  }
  {
    // The rename really failed (the name is still held): nothing else is renamed.
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: "", size: 12 }, { ...backup }] });
    const rename = github.rename;
    github.rename = async (id, name, label) => { if (id === 7) { state.calls.push(["rename", id, name]); const error = new Error("socket hang up"); error.status = 502; throw error; } return rename(id, name, label); };
    await assert.rejects(repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {}, sleep: async () => {} }), /socket hang up/);
    assert.equal(state.assets.find((asset) => asset.id === 3).name, backup.name, "the backup stays where it was");
    assert.equal(state.assets.find((asset) => asset.id === 7).name, "state.enc");
  }
  {
    // The verifying listing fails: nothing else is renamed.
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: "", size: 12 }, { ...backup }] });
    const rename = github.rename;
    github.rename = async (id, name, label) => { const result = await rename(id, name, label); if (id === 7) { const error = new Error("socket hang up"); error.status = 502; throw error; } return result; };
    let releases = 0;
    state.hooks.release = () => { releases += 1; if (releases >= 2) throw new Error("listing unavailable"); };
    await assert.rejects(repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {}, sleep: async () => {} }));
    assert.equal(state.assets.find((asset) => asset.id === 3).name, backup.name);
  }
});

test("an upload whose response was lost is installed at once when the restore name is absent", async () => {
  const { github, state } = fakeGitHub({ assets: [] });
  const upload = github.upload;
  github.upload = async (...args) => { await upload(...args); const error = new Error("The operation was aborted due to timeout"); error.name = "TimeoutError"; throw error; };
  const warnings = [];
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 5, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} });
  assert.equal(result.published, true);
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 5, "the name is not left missing until a later repair");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /upload/.test(line)));
});

test("an upload whose response was lost completes the swap when the restore name exists", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const upload = github.upload;
  github.upload = async (...args) => { await upload(...args); const error = new Error("socket hang up"); error.status = 502; throw error; };
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, true);
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc")?.label)?.height, 2150);
  assert.match(state.assets.find((asset) => asset.id === 7).name, /^prev-/);
});

test("a failed upload is only adopted when the listing shows that exact upload complete", async () => {
  for (const [what, tamper] of [
    ["the POST failed before GitHub stored anything", (s) => { s.assets = s.assets.filter((asset) => !/^next-/.test(asset.name)); }],
    ["the upload is still in the starter state", (s) => { for (const asset of s.assets) if (/^next-/.test(asset.name)) Object.assign(asset, { state: "starter", size: 0 }); }],
    ["the upload is in the starter state with its full size", (s) => { for (const asset of s.assets) if (/^next-/.test(asset.name)) asset.state = "starter"; }],
    ["only an older keeper copy with the same label and size exists", (s) => { for (const asset of s.assets) if (/^next-/.test(asset.name)) asset.name = keeperAssetName("next", "state.enc", T0 - 60_000, "abcdef01"); }],
    ["the stored asset is shorter than the snapshot", (s) => { for (const asset of s.assets) if (/^next-/.test(asset.name)) asset.size -= 1; }],
    ["the stored asset carries another label", (s) => { for (const asset of s.assets) if (/^next-/.test(asset.name)) asset.label = formatLabel(9999, GENESIS); }]
  ]) {
    const { github, state } = fakeGitHub({ assets: [] });
    const upload = github.upload;
    github.upload = async (...args) => { await upload(...args); tamper(state); const error = new Error("socket hang up"); error.status = 502; throw error; };
    await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 5, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} }), /socket hang up/, what);
    assert.ok(!state.assets.some((asset) => asset.name === "state.enc"), `${what}: nothing is installed`);
    assert.ok(!state.calls.some((call) => call[0] === "rename" || call[0] === "remove"), `${what}: nothing is renamed or deleted`);
  }
  {
    // The listing after the failure is unavailable: the error stands and nothing is touched.
    const { github, state } = fakeGitHub({ assets: [] });
    const upload = github.upload;
    github.upload = async (...args) => { await upload(...args); const error = new Error("socket hang up"); error.status = 502; throw error; };
    let listings = 0;
    state.hooks.release = () => { listings += 1; if (listings >= 2) throw new Error("listing unavailable"); };
    await assert.rejects(publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 5, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} }), /socket hang up/);
    assert.ok(!state.calls.some((call) => call[0] === "rename" || call[0] === "remove"));
  }
});

test("runKeeper skips publication when a repair crosses the run deadline", async () => {
  const time = virtualTime();
  const { github, state } = fakeGitHub({ now: time.now, assets: [{ id: 3, name: keeperAssetName("prev", "state.enc", T0 - 5 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) }] });
  state.hooks.rename = () => time.sleep(2 * 60_000);
  const snapshotRequests = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return new Response("{}", { status: 200 });
    snapshotRequests.push(time.now());
    return new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS } });
  };
  const warnings = [];
  await time.run(runKeeper({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: time.sleep, log() {}, warn: (line) => warnings.push(line) }));
  assert.equal(state.assets.find((asset) => asset.id === 3)?.name, "state.enc", "the repair that started before the deadline completes");
  assert.deepEqual(snapshotRequests, [], "no snapshot download or upload starts after the deadline");
  assert.ok(!state.calls.some((call) => call[0] === "upload"));
  assert.ok(warnings.some((line) => /deadline/.test(line)));
});

test("publishAsset replaces an incomplete canonical asset only when it is provably incomplete and not labeled for another genesis", async () => {
  {
    // A `starter` asset abandoned long ago is incomplete whatever size or label height GitHub reports.
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(9999, GENESIS), state: "starter", size: 1000, updated_at: new Date(T0 - 20 * 60_000).toISOString() }] });
    const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
    assert.equal(result.published, true);
    assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc").label).height, 2150);
  }
  {
    // A fresh `starter` asset may be another keeper's newer snapshot still uploading: the normal rules apply.
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: "", state: "starter", size: 0, updated_at: new Date(T0 - 10_000).toISOString() }] });
    const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0 - 60_000, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
    assert.equal(result.published, false, "a fresh in-progress upload is not replaced");
    assert.equal(state.assets.find((asset) => asset.name === "state.enc").id, 7);
  }
  {
    const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(9999, OTHER), size: 12 }] });
    const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
    assert.equal(result.published, false, "an asset labeled for another genesis is never replaced");
    assert.equal(state.assets.find((asset) => asset.name === "state.enc").id, 7);
  }
});

test("publishAsset replaces a canonical asset that is incomplete, even when it is fresh and unlabeled", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: "", size: 12, updated_at: new Date(T0 - 10_000).toISOString() }] });
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, true);
  assert.equal(parseLabel(state.assets.find((asset) => asset.name === "state.enc").label).height, 2150);
});

test("publishAsset does not start the swap after its swap deadline and drops the upload", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const result = await publishAsset({ github, tag: "t", name: "state.enc", bytes: sealed(), snapshot: { height: 2150, genesis: GENESIS }, expectedGenesis: GENESIS, requestStartedMs: T0, now: () => T0 + 1, swapBy: T0, log() {}, warn() {}, sleep: async () => {} });
  assert.equal(result.published, false);
  assert.match(result.reason, /deadline/);
  assert.deepEqual(state.assets.map((asset) => [asset.id, asset.name]), [[7, "state.enc"]], "state.enc untouched, upload removed");
  assert.ok(!state.calls.some((call) => call[0] === "rename"));
});

test("repairAndCleanup keeps the best copy as a backup and deletes only this keeper's stale surplus copies", async () => {
  const assets = [
    { id: 1, name: "state.enc" }, { id: 2, name: "state-9ad75d777141.enc" },
    { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 31 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) },
    { id: 9, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "eeeeeeee"), label: formatLabel(2200, GENESIS) },
    { id: 4, name: keeperAssetName("next", "state.enc", T0 - 60_000, "bbbbbbbb"), label: formatLabel(2000, GENESIS) },
    { id: 5, name: "state-next-x.enc" }, { id: 6, name: `next-${T0 - 40 * 60_000}-cccccccc.other.enc` },
    { id: 8, name: keeperAssetName("next", "state-9ad75d777141.enc", T0 - 45 * 60_000, "dddddddd"), label: formatLabel(2100, GENESIS) },
    { id: 10, name: keeperAssetName("prev", "state-9ad75d777141.enc", T0 - 46 * 60_000, "ffffffff"), label: "" }
  ];
  const { github, state } = fakeGitHub({ assets });
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
  // state.enc: 9 (highest) is the backup, 3 is stale surplus, 4 is fresh. Per-genesis: 8 is the backup, 10 stale surplus.
  assert.deepEqual(state.assets.map((asset) => asset.id).sort((a, b) => a - b), [1, 2, 4, 5, 6, 8, 9]);
});

test("repairAndCleanup deletes nothing when the name disappears between listings", async () => {
  const assets = [
    { id: 1, name: "state.enc" },
    { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 40 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) },
    { id: 4, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "bbbbbbbb"), label: formatLabel(2000, GENESIS) }
  ];
  const { github, state } = fakeGitHub({ assets });
  let listings = 0;
  state.hooks.release = (s) => { listings += 1; if (listings === 2) s.assets = s.assets.filter((asset) => asset.id !== 1); };
  const warnings = [];
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn: (line) => warnings.push(line) });
  assert.deepEqual(state.assets.map((asset) => asset.id), [3, 4], "no copy is deleted while the name is missing");
  assert.ok(!state.calls.some((call) => call[0] === "remove"));
  assert.ok(warnings.some((line) => /disappeared/.test(line)));
});

test("repairAndCleanup restores a missing name only from a trustworthy copy", async () => {
  // Labeled copies of the expected genesis win by height; a labeled copy of another genesis is never used.
  {
    const { github, state } = fakeGitHub({ assets: [
      { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) },
      { id: 4, name: keeperAssetName("next", "state.enc", T0 - 40 * 60_000, "bbbbbbbb"), label: formatLabel(2150, GENESIS) },
      { id: 5, name: keeperAssetName("next", "state.enc", T0 - 30_000, "cccccccc"), label: formatLabel(9999, OTHER) }
    ] });
    await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
    assert.equal(state.assets.find((asset) => asset.name === "state.enc")?.id, 4);
    assert.deepEqual(state.assets.map((asset) => asset.id).sort(), [3, 4, 5], "the best remaining copy stays as a backup; the fresh one waits");
  }
  // An unlabeled moved-aside asset (legacy keeper) is restored rather than leaving the name missing.
  {
    const { github, state } = fakeGitHub({ assets: [{ id: 3, name: keeperAssetName("prev", "state.enc", T0 - 60 * 60_000, "aaaaaaaa"), label: "" }] });
    await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
    assert.deepEqual(state.assets.map((asset) => [asset.id, asset.name]), [[3, "state.enc"]]);
  }
  // An unlabeled or foreign-genesis upload is never promoted, and nothing is deleted while the name is missing.
  {
    const { github, state } = fakeGitHub({ assets: [
      { id: 4, name: keeperAssetName("next", "state.enc", T0 - 60 * 60_000, "bbbbbbbb"), label: "" },
      { id: 5, name: keeperAssetName("next", "state.enc", T0 - 60 * 60_000, "cccccccc"), label: formatLabel(10, OTHER) }
    ] });
    await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
    assert.ok(!state.assets.some((asset) => asset.name === "state.enc"), "no untrusted copy is promoted");
    assert.deepEqual(state.assets.map((asset) => asset.id), [4, 5], "nothing is deleted while the name is missing");
  }
});

test("repairAndCleanup never promotes or keeps as the backup an incomplete or empty asset", async () => {
  const { github, state } = fakeGitHub({ assets: [
    { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) },
    { id: 4, name: keeperAssetName("next", "state.enc", T0 - 40 * 60_000, "bbbbbbbb"), label: formatLabel(2150, GENESIS), state: "starter", size: 0 },
    { id: 5, name: keeperAssetName("next", "state.enc", T0 - 45 * 60_000, "cccccccc"), label: formatLabel(2140, GENESIS), size: 0 }
  ] });
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
  assert.equal(state.assets.find((asset) => asset.name === "state.enc")?.id, 3, "the complete copy is restored, not a failed upload");
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
  assert.deepEqual(state.assets.map((asset) => asset.id), [3], "stale incomplete uploads are surplus, never the kept backup");
  // An incomplete copy alone is never promoted.
  const lone = fakeGitHub({ assets: [{ id: 6, name: keeperAssetName("prev", "state.enc", T0 - 60 * 60_000, "dddddddd"), label: "", state: "starter", size: 0 }] });
  await repairAndCleanup({ github: lone.github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
  assert.ok(!lone.state.assets.some((asset) => asset.name === "state.enc"));
});

test("repairAndCleanup replaces an incomplete canonical asset with the best complete backup", async () => {
  for (const broken of [
    { state: "starter", size: 0, updated_at: new Date(T0 - 20 * 60_000).toISOString() },
    { state: "uploaded", size: 12, updated_at: new Date(T0 - 30_000).toISOString() }
  ]) {
    const { github, state } = fakeGitHub({ assets: [
      { id: 1, name: "state.enc", label: "", ...broken },
      { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) }
    ] });
    await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
    assert.equal(state.assets.find((asset) => asset.name === "state.enc")?.id, 3, JSON.stringify(broken));
    assert.match(state.assets.find((asset) => asset.id === 1)?.name ?? "deleted", /^prev-|^deleted$/);
  }
  // An upload that may still be in progress (starter, updated moments ago) is left alone.
  const { github, state } = fakeGitHub({ assets: [
    { id: 1, name: "state.enc", label: "", state: "starter", size: 0, updated_at: new Date(T0 - 60_000).toISOString() },
    { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) }
  ] });
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
  assert.equal(state.assets.find((asset) => asset.name === "state.enc")?.id, 1);
});

test("repairAndCleanup never restores a moved-aside copy labeled for another genesis", async () => {
  {
    const { github, state } = fakeGitHub({ assets: [
      { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 10 * 60_000, "aaaaaaaa"), label: formatLabel(9999, OTHER) },
      { id: 4, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "bbbbbbbb"), label: "" }
    ] });
    await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
    assert.equal(state.assets.find((asset) => asset.name === "state.enc")?.id, 4, "the unlabeled legacy copy, not the foreign one");
  }
  {
    const { github, state } = fakeGitHub({ assets: [{ id: 3, name: keeperAssetName("prev", "state.enc", T0 - 10 * 60_000, "aaaaaaaa"), label: formatLabel(9999, OTHER) }] });
    await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
    assert.ok(!state.assets.some((asset) => asset.name === "state.enc"));
  }
});

test("repairAndCleanup deletes stale incomplete copies even while the name is missing", async () => {
  const { github, state } = fakeGitHub({ assets: [
    { id: 4, name: keeperAssetName("next", "state.enc", T0 - 40 * 60_000, "bbbbbbbb"), label: formatLabel(2150, GENESIS), state: "starter", size: 0 },
    { id: 5, name: keeperAssetName("next", "state.enc", T0 - 50 * 60_000, "cccccccc"), label: formatLabel(2140, GENESIS), size: 0 },
    { id: 6, name: keeperAssetName("next", "state.enc", T0 - 60_000, "dddddddd"), label: formatLabel(2160, GENESIS), state: "starter", size: 0 }
  ] });
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn() {} });
  assert.deepEqual(state.assets.map((asset) => asset.id), [6], "stale incomplete copies are deleted; a fresh one waits");
});

function gatewayFetch({ height = 2150, genesis = GENESIS, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith("/health")) return new Response(JSON.stringify({ ok: true, status: "ready", maxHeight: height }), { status: 200 });
    const bytes = sealed();
    return new Response(bytes, { status, headers: { "x-zyron-snapshot-height": String(height), "x-zyron-genesis-hash": genesis, "content-length": String(bytes.length) } });
  };
  return { fetchImpl, calls };
}

test("publishCycle publishes state.enc and the per-genesis copy", async () => {
  const { github, state } = fakeGitHub();
  const { fetchImpl } = gatewayFetch();
  const result = await publishCycle({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {} });
  assert.equal(result.published, true);
  assert.equal(result.copyPublished, true);
  assert.deepEqual(state.assets.map((asset) => asset.name).sort(), ["state-9ad75d777141.enc", "state.enc"]);
  assert.match(result.sha256, /^[0-9a-f]{64}$/);
});

test("publishCycle keeps the state.enc result when the per-genesis copy fails", async () => {
  const { github, state } = fakeGitHub();
  const upload = github.upload;
  github.upload = async (releaseId, name, label, bytes) => { if (name.endsWith(".state-9ad75d777141.enc")) { const error = new Error("upload outage"); error.status = 503; throw error; } return upload(releaseId, name, label, bytes); };
  const { fetchImpl } = gatewayFetch();
  const warnings = [];
  const result = await publishCycle({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} });
  assert.equal(result.published, true, "state.enc was published");
  assert.equal(result.copyPublished, false);
  assert.ok(state.assets.some((asset) => asset.name === "state.enc"));
  assert.ok(warnings.some((line) => /upload outage/.test(line)));
  {
    // In runKeeper the run counts the publication, so it does not fail.
    const time = virtualTime();
    const run = fakeGitHub({ now: time.now });
    const runUpload = run.github.upload;
    run.github.upload = async (releaseId, name, label, bytes) => { if (name.endsWith(".state-9ad75d777141.enc")) { const error = new Error("upload outage"); error.status = 503; throw error; } return runUpload(releaseId, name, label, bytes); };
    let height = 2150;
    const runFetch = async (url) => url.endsWith("/health") ? new Response("{}", { status: 200 })
      : new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": String(height += 10), "x-zyron-genesis-hash": GENESIS } });
    const stats = await time.run(runKeeper({ fetchImpl: runFetch, github: run.github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 20 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: time.sleep, log() {}, warn() {} }));
    assert.equal(stats.published, 2);
    assert.equal(exitCodeFor(stats), 0);
  }
});

test("publishCycle never publishes another genesis", async () => {
  const { github, state } = fakeGitHub({ assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }] });
  const { fetchImpl } = gatewayFetch({ genesis: OTHER, height: 5 });
  await assert.rejects(publishCycle({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, now: () => T0, log() {} }), GenesisMismatchError);
  assert.deepEqual(state.calls, []);
  assert.equal(state.assets[0].label, formatLabel(2100, GENESIS));
});

test("runKeeper polls health, publishes on its interval and stops at the deadline", async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now });
  let height = 2150;
  const health = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) { health.push(time.now()); return new Response(JSON.stringify({ ok: true, status: "ready", maxHeight: height }), { status: 200 }); }
    height += 20;
    return new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": String(height), "x-zyron-genesis-hash": GENESIS } });
  };
  const stats = await time.run(runKeeper({
    fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS,
    runMs: 30 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000,
    now: time.now, sleep: time.sleep, log() {}, warn() {}
  }));
  assert.equal(stats.cycles, 3);
  assert.equal(stats.published, 3);
  assert.equal(stats.lastPublishedHeight, 2210);
  assert.deepEqual(health.map((at) => (at - T0) / 60_000), [0, 5, 10, 15, 20, 25]);
  assert.equal(exitCodeFor(stats), 0);
});

test("runKeeper keeps polling health while a slow publish cycle is still running", async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now });
  const upload = github.upload;
  github.upload = async (...args) => { await time.sleep(20 * 60_000); return upload(...args); };
  const health = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) { health.push(time.now()); return new Response("{}", { status: 200 }); }
    return new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS } });
  };
  const stats = await time.run(runKeeper({
    fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS,
    runMs: 30 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000,
    now: time.now, sleep: time.sleep, log() {}, warn() {}
  }));
  assert.equal(stats.published, 1, "one 40-minute cycle (two slow uploads)");
  const gaps = health.slice(1).map((at, index) => at - health[index]);
  assert.ok(health.length >= 6 && gaps.every((gap) => gap <= 5 * 60_000), `health gaps ${gaps.map((gap) => gap / 60_000)} min`);
});

test("runKeeper returns at its deadline instead of sleeping a full interval past it", async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now });
  const health = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) { health.push(time.now()); return new Response("{}", { status: 200 }); }
    return new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS } });
  };
  const stats = await time.run(runKeeper({
    fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS,
    runMs: 7 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000,
    now: time.now, sleep: time.sleep, log() {}, warn() {}
  }));
  assert.equal(stats.cycles, 1);
  assert.deepEqual(health.map((at) => (at - T0) / 60_000), [0, 5]);
  assert.equal(time.now() - T0, 7 * 60_000, "both loops stop at the deadline");
});

test("runKeeper never starts a swap after its deadline, even when a slow upload ends past it", async () => {
  const time = virtualTime();
  const { github, state } = fakeGitHub({ now: time.now, assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }, { id: 8, name: "state-9ad75d777141.enc", label: formatLabel(2100, GENESIS) }] });
  const upload = github.upload;
  github.upload = async (...args) => { await time.sleep(20 * 60_000); return upload(...args); };
  const fetchImpl = async (url) => url.endsWith("/health") ? new Response("{}", { status: 200 })
    : new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS } });
  const stats = await time.run(runKeeper({
    fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS,
    runMs: 15 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000,
    now: time.now, sleep: time.sleep, log() {}, warn() {}
  }));
  assert.equal(stats.published, 0);
  assert.ok(!state.calls.some((call) => call[0] === "rename"), "nothing is renamed aside once the deadline has passed");
  assert.deepEqual(state.assets.map((asset) => asset.id).sort((a, b) => a - b), [7, 8]);
});

test("runKeeper keeps polling health until a publish cycle that overran the deadline settles, and starts no upload after it", async () => {
  const time = virtualTime();
  const { github, state } = fakeGitHub({ now: time.now, assets: [{ id: 7, name: "state.enc", label: formatLabel(2100, GENESIS) }, { id: 8, name: "state-9ad75d777141.enc", label: formatLabel(2100, GENESIS) }] });
  const upload = github.upload;
  github.upload = async (...args) => { await time.sleep(20 * 60_000); return upload(...args); };
  const health = [];
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) { health.push(time.now()); return new Response("{}", { status: 200 }); }
    return new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS } });
  };
  await time.run(runKeeper({
    fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS,
    runMs: 15 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000,
    now: time.now, sleep: time.sleep, log() {}, warn() {}
  }));
  assert.equal(time.now() - T0, 20 * 60_000, "the run ends when the overrunning cycle settles");
  assert.deepEqual(health.map((at) => (at - T0) / 60_000), [0, 5, 10, 15], "health is still polled after the deadline while the cycle runs");
  assert.equal(state.calls.filter((call) => call[0] === "upload").length, 1, "the per-genesis upload is not started after the deadline");
});

test("a run whose every cycle was refused for a safety reason fails instead of counting as up to date", async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now, assets: [{ id: 7, name: "state.enc", label: formatLabel(10, OTHER) }] });
  const fetchImpl = async (url) => url.endsWith("/health") ? new Response("{}", { status: 200 })
    : new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS } });
  const warnings = [];
  const stats = await time.run(runKeeper({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 20 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: time.sleep, log() {}, warn: (line) => warnings.push(line) }));
  assert.equal(stats.notNewer, 0);
  assert.equal(stats.refused, 2);
  assert.equal(exitCodeFor(stats), 1);
  assert.ok(warnings.some((line) => /labeled for genesis 822cf0080000/.test(line)));
  // A genuinely current published asset is still success.
  assert.equal(exitCodeFor({ published: 0, notNewer: 1, refused: 2, genesisMismatches: 0 }), 0);
  assert.equal(exitCodeFor({ published: 0, notNewer: 0, refused: 3, genesisMismatches: 0 }), 1);
});

test("runKeeper starts each publish cycle on its interval measured from the previous cycle start", async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now });
  const upload = github.upload;
  github.upload = async (...args) => { await time.sleep(4 * 60_000); return upload(...args); };
  const requests = [];
  let height = 2150;
  const fetchImpl = async (url) => {
    if (url.endsWith("/health")) return new Response("{}", { status: 200 });
    requests.push((time.now() - T0) / 60_000);
    height += 10;
    return new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": String(height), "x-zyron-genesis-hash": GENESIS } });
  };
  await time.run(runKeeper({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 30 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: time.sleep, log() {}, warn() {} }));
  assert.deepEqual(requests, [0, 10, 20], "an 8-minute cycle does not push the next snapshot request to minute 18");
});

test("runKeeper cancels its pending keepalive wait when publishing stops, so the process can exit", async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now });
  const signals = [];
  const fetchImpl = async (url) => url.endsWith("/health") ? new Response("{}", { status: 200 })
    : new Response(sealed(), { status: 200, headers: { "x-zyron-snapshot-height": "2150", "x-zyron-genesis-hash": GENESIS } });
  await time.run(runKeeper({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 7 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: (ms, signal) => { signals.push(signal); return time.sleep(ms); }, log() {}, warn() {} }));
  assert.ok(signals.length > 0 && signals.every((signal) => signal?.aborted === true), "every wait still pending at the end is cancelled");
  // The real sleep clears its timer on abort.
  const timers = () => process.getActiveResourcesInfo().filter((kind) => kind === "Timeout").length;
  const before = timers();
  const controller = new AbortController();
  const waiting = cancellableSleep(10 * 60_000, controller.signal);
  assert.equal(timers(), before + 1);
  controller.abort();
  await waiting;
  assert.equal(timers(), before, "no live timer is left behind");
});

test("runKeeper aborts an in-flight health request when publishing stops", { timeout: 15_000 }, async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now });
  let healthCalls = 0;
  const fetchImpl = (url, init) => {
    if (!url.endsWith("/health")) return Promise.resolve(new Response("down", { status: 503 }));
    healthCalls += 1;
    // A gateway that never answers: only an abort ends the request.
    return new Promise((resolve, reject) => {
      if (init?.signal?.aborted) { reject(init.signal.reason); return; }
      init?.signal?.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
  };
  const started = Date.now();
  await time.run(runKeeper({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: time.sleep, log() {}, warn() {} }));
  assert.equal(healthCalls, 1);
  assert.ok(Date.now() - started < 5_000, `runKeeper returned ${Date.now() - started} ms after the publish loop stopped, not after the request timeout`);
});

test("a swap started at the deadline finishes or rolls back well before the workflow timeout", async () => {
  const workflow = await readFile(new URL("../workflows/open-testnet-snapshot-keeper.yml", import.meta.url), "utf8");
  const timeout = Number(/^\s+timeout-minutes: (\d+)$/m.exec(workflow)?.[1]);
  const runMinutes = Number(/RUN_MINUTES: \$\{\{ inputs\.run_minutes \|\| '(\d+)' \}\}/.exec(workflow)?.[1]);
  // Worst case after the swap check: rename aside, a listing that verifies an
  // ambiguous aside rename, rename into place, a listing that verifies an
  // ambiguous final rename, rename back, deleting the upload, each with every
  // retry timing out (a listing shares one timeout across its pages); plus 2
  // minutes for job set-up. A repair started before the deadline moves an
  // incomplete asset aside and renames a backup into place.
  const rename = (RENAME_RETRY_DELAYS_MS.length + 1) * GITHUB_CALL_TIMEOUT_MS + RENAME_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
  const swap = 3 * rename + 3 * GITHUB_CALL_TIMEOUT_MS;
  assert.ok(swap + 2 * 60_000 <= (timeout - runMinutes) * 60_000, `swap worst case ${swap} ms must fit in ${timeout - runMinutes} min`);
  // (2 listings: the repair's own and the one that verifies an ambiguous aside rename.)
  const repair = 2 * rename + 2 * GITHUB_CALL_TIMEOUT_MS;
  assert.ok(repair + 2 * 60_000 <= (timeout - runMinutes) * 60_000, `repair worst case ${repair} ms must fit in ${timeout - runMinutes} min`);
});

test("a release listing shares one GitHub call timeout across all its pages", async () => {
  const signals = [];
  const page = (count, offset) => Array.from({ length: count }, (_, i) => ({ id: offset + i, name: `a${offset + i}` }));
  const fetchImpl = async (url, init) => {
    signals.push(init.signal);
    if (url.includes("/releases/tags/")) return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    if (/[?&]page=1$/.test(url)) return new Response(JSON.stringify(page(100, 0)), { status: 200 });
    if (/[?&]page=2$/.test(url)) return new Response(JSON.stringify(page(3, 100)), { status: 200 });
    return new Response(JSON.stringify({ id: 1, name: "x" }), { status: 200 });
  };
  const github = createGitHub({ fetchImpl, token: "t0ken", repo: "a/b" });
  const release = await github.release("t");
  assert.equal(release.assets.length, 103);
  assert.equal(signals.length, 3);
  assert.ok(signals.every((signal) => signal === signals[0]), "one deadline for the whole listing");
  await github.rename(5, "y", "");
  assert.notEqual(signals[3], signals[0], "other calls get their own timeout");
});

test("repairAndCleanup starts no rename or delete after the run deadline", async () => {
  const { github, state } = fakeGitHub({ assets: [
    { id: 3, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) },
    { id: 8, name: "state-9ad75d777141.enc", label: formatLabel(2100, GENESIS) },
    { id: 4, name: keeperAssetName("prev", "state-9ad75d777141.enc", T0 - 50 * 60_000, "bbbbbbbb"), label: formatLabel(2000, GENESIS) },
    { id: 5, name: keeperAssetName("prev", "state-9ad75d777141.enc", T0 - 60 * 60_000, "cccccccc"), label: formatLabel(1900, GENESIS) }
  ] });
  const warnings = [];
  await repairAndCleanup({ github, tag: "t", expectedGenesis: GENESIS, now: () => T0, swapBy: T0 - 1, log() {}, warn: (line) => warnings.push(line), sleep: async () => {} });
  assert.ok(!state.calls.some((call) => call[0] === "rename" || call[0] === "remove"));
  assert.ok(warnings.some((line) => /deadline/.test(line)));
  {
    // Cleanup only (the name exists): not even the re-check listing starts after the deadline.
    const cleanup = fakeGitHub({ assets: state.assets.filter((asset) => asset.id !== 3) });
    await repairAndCleanup({ github: cleanup.github, tag: "t", expectedGenesis: GENESIS, now: () => T0, swapBy: T0 - 1, log() {}, warn() {}, sleep: async () => {} });
    assert.deepEqual(cleanup.state.calls.map((call) => call[0]), ["release"], "no listing, rename or delete after the deadline");
  }
  // runKeeper passes its run deadline: a cycle whose listing returns after it repairs nothing.
  const time = virtualTime();
  const slow = fakeGitHub({ now: time.now, assets: [{ id: 3, name: keeperAssetName("prev", "state.enc", T0 - 50 * 60_000, "aaaaaaaa"), label: formatLabel(2100, GENESIS) }] });
  slow.state.hooks.release = () => time.sleep(2 * 60_000);
  const fetchImpl = async (url) => url.endsWith("/health") ? new Response("{}", { status: 200 }) : new Response("down", { status: 503 });
  await time.run(runKeeper({ fetchImpl, github: slow.github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: time.sleep, log() {}, warn() {} }));
  assert.ok(!slow.state.calls.some((call) => call[0] === "rename"), "no repair rename after the deadline");
});

test("runKeeper survives gateway outages and reports failure only when nothing was ever up to date", async () => {
  const time = virtualTime();
  const { github } = fakeGitHub({ now: time.now });
  const fetchImpl = async () => new Response("down", { status: 503 });
  const warnings = [];
  const stats = await time.run(runKeeper({ fetchImpl, github, gateway: "https://gw", tag: "t", expectedGenesis: GENESIS, runMs: 20 * 60_000, publishIntervalMs: 10 * 60_000, keepAliveIntervalMs: 5 * 60_000, now: time.now, sleep: time.sleep, log() {}, warn: (line) => warnings.push(line) }));
  assert.equal(stats.failures, 2);
  assert.equal(exitCodeFor(stats), 1);
  assert.ok(warnings.length === 2 && warnings.every((line) => /HTTP 503/.test(line)));
  assert.equal(exitCodeFor({ published: 0, notNewer: 3, genesisMismatches: 0 }), 0);
  assert.equal(exitCodeFor({ published: 5, notNewer: 0, genesisMismatches: 1 }), 1);
});

test("snapshot downloads are size-capped before and while reading, and error bodies are not read", async () => {
  const big = new Response("x", { status: 200, headers: { "content-length": String(300 * 1024 * 1024) } });
  await assert.rejects(readCapped(big, 256 * 1024 * 1024), /content-length/);
  await assert.rejects(readCapped(new Response("x", { headers: { "content-length": "12abc" } }), 1000), /content-length/);
  let pulled = 0;
  // A finite but oversized body without content-length (64 KiB against a 10 KiB cap).
  const chunked = (counter) => new ReadableStream({ pull(controller) { counter(); if (pulledTotal() >= 64) controller.close(); else controller.enqueue(new Uint8Array(1024)); } });
  let pulledTotal = () => pulled;
  await assert.rejects(readCapped(new Response(chunked(() => { pulled += 1; })), 10 * 1024), /exceeds 10240 bytes/);
  assert.ok(pulled <= 13, `stopped reading after the cap (${pulled} chunks)`);
  assert.equal((await readCapped(new Response(sealed(100)), 1000)).length, SNAPSHOT_HEADER.length + 100);
  let errorBodyPulled = 0;
  pulledTotal = () => errorBodyPulled;
  const errorBody = chunked(() => { errorBodyPulled += 1; });
  await assert.rejects(fetchSnapshot({ fetchImpl: async () => new Response(errorBody, { status: 429 }), gateway: "https://gw", expectedGenesis: GENESIS, now: () => T0 }), /HTTP 429/);
  assert.ok(errorBodyPulled <= 2, `a non-200 body is cancelled, not read (${errorBodyPulled} chunks)`);
});

test("createGitHub sends authenticated requests to the documented endpoints", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, auth: init.headers.authorization, type: init.headers["content-type"], body: init.body });
    if (url.includes("/releases/tags/")) return new Response(JSON.stringify({ id: 42 }), { status: 200 });
    if (init.method === "GET" && url.includes("/releases/42/assets")) return new Response(JSON.stringify([{ id: 1, name: "state.enc" }]), { status: 200 });
    if (init.method === "POST") return new Response(JSON.stringify({ id: 9 }), { status: 201 });
    if (init.method === "DELETE") return new Response(null, { status: url.endsWith("/404") ? 404 : 204 });
    if (init.method === "PATCH") return new Response(JSON.stringify({ id: 9 }), { status: 200 });
    return new Response("no", { status: 500 });
  };
  const github = createGitHub({ fetchImpl, token: "t0ken", repo: "zyron249/-zyronchain" });
  assert.deepEqual(await github.release("open-testnet-state"), { id: 42, assets: [{ id: 1, name: "state.enc" }] });
  await github.upload(42, "state-next-1.enc", formatLabel(5, GENESIS), sealed());
  assert.equal(await github.remove(3), true);
  assert.equal(await github.remove(404), false);
  await github.rename(9, "state.enc", formatLabel(5, GENESIS));
  assert.ok(seen.every((call) => call.auth === "Bearer t0ken"));
  const upload = seen.find((call) => call.method === "POST");
  assert.match(upload.url, /^https:\/\/uploads\.github\.com\/repos\/zyron249\/-zyronchain\/releases\/42\/assets\?name=state-next-1\.enc&label=/);
  assert.equal(upload.type, "application/octet-stream");
  const patch = seen.find((call) => call.method === "PATCH");
  assert.equal(patch.url, "https://api.github.com/repos/zyron249/-zyronchain/releases/assets/9");
  assert.deepEqual(JSON.parse(patch.body), { name: "state.enc", label: formatLabel(5, GENESIS) });
  assert.throws(() => createGitHub({ fetchImpl, token: "", repo: "a/b" }), /GITHUB_TOKEN/);
  assert.throws(() => createGitHub({ fetchImpl, token: "x", repo: "a/b/../c" }), /invalid repository/);
});

test("the scheduled workflow keeps least privilege, one active run, a bounded job and the pinned genesis", async () => {
  const workflow = await readFile(new URL("../workflows/open-testnet-snapshot-keeper.yml", import.meta.url), "utf8");
  const active = workflow.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
  assert.match(active, /^on:\n  schedule:\n    - cron: '[^']+'\n  workflow_dispatch:/m);
  assert.match(active, /^permissions: \{\}$/m, "no workflow-level permissions");
  assert.deepEqual([...active.matchAll(/^\s+permissions:\n\s+(\S.*)$/gm)].map((match) => match[1]), ["contents: write"], "only the job gets contents: write");
  assert.match(active, /^concurrency:\n  group: open-testnet-snapshot-keeper\n  cancel-in-progress: false$/m, "exactly one active run; never cancel a run mid-upload");
  const timeout = Number(/^\s+timeout-minutes: (\d+)$/m.exec(active)?.[1]);
  const runMinutes = Number(/RUN_MINUTES: \$\{\{ inputs\.run_minutes \|\| '(\d+)' \}\}/.exec(active)?.[1]);
  assert.ok(timeout <= 360 && runMinutes > 0 && runMinutes + 10 <= timeout, `job timeout ${timeout} must exceed the run length ${runMinutes} and stay within 360`);
  assert.match(active, /EXPECTED_GENESIS: 9ad75d777141de46df1fb008298a4d8a92fbce0a9c96aaf26ecf69474b7db8eb$/m);
  assert.match(active, /if: github\.repository == 'zyron249\/-zyronchain'/);
  assert.deepEqual([...active.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)].map((match) => match[1]).sort(), ["github.repository", "github.token", "inputs.run_minutes || '340'"], "no secrets and no untrusted expression in a script");
  assert.doesNotMatch(active, /secrets\./);
  for (const use of active.matchAll(/uses: (\S+)/g)) assert.match(use[1], /^actions\/(checkout|setup-node)@[0-9a-f]{40}$/, `unpinned or unexpected action ${use[1]}`);
  assert.match(active, /persist-credentials: false/);
  assert.match(active, /run: node \.github\/scripts\/open-testnet-snapshot-keeper\.mjs$/m);
});
