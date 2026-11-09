// S2-3 (Red Team Session 2, Nov 3; Security acceptance gaps, Nov 9): a restore
// must be bound to an independently authenticated expected summary, not to a
// summary derived from the snapshot being restored.
//
// FAILING FIRST BY DESIGN. These tests were written before any implementation
// and are expected to fail on main (see the PR for the base SHA and the
// failure output). A separate implementation branch makes them pass. No
// production code is changed here.
//
// Trust anchor (Patron's choice "T1", confirmed by Security on Nov 9): an
// externally sealed summary for open-testnet backups only, signed with Ed25519
// by a dedicated testnet summary key whose public key is pinned in the repo,
// plus an append-only "superseded" record so superseded tips and summaries are
// refused. The expected summary is also matched against the tip a live quorum
// reports for that height; it is never taken from the snapshot itself.
//
// Every key in this file is a TEST FIXTURE generated at runtime inside the
// test. None of them is, or may be used as, the pinned testnet summary key.
//
// Proposed contract the implementation has to meet (names are the test's
// requirements; Security reviews the exact encoding at the implementation
// head):
//
//   restoreNetwork(dir, bundle, expectedChainId, { onProgress, restoreAnchor })
//   restoreNetworkWithLocalRetry(dir, bundle, expectedChainId, { ..., restoreAnchor })
//   restoreAnchor = {
//     pinnedKeys: [{ keyId, publicKey /* raw 32-byte Ed25519, hex */, revoked? }],
//     readSeal: async () => ({ summary, keyId, signature /* hex */ }) | null,
//     readSuperseded: async () => [{ summaryDigest, height, tipHash }],
//     readQuorumTip: async (height) => ({ height, tipHash }),
//   }
//   signed message = SEAL_DOMAIN || 0x00 || canonicalJson({ keyId, summary })
//   summaryDigest  = sha256(signed message), hex
//
// Every refusal is fail-closed: the promise rejects with an Error whose
// `code` is the listed reason, the error is never marked `localIo` (so it is
// not retried as a disk failure), and no network.json completion marker is
// written. Refusals that need nothing from the replay also happen before any
// key file is written.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after, before } from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { ChainStore }: any = await import(pathToFileURL(join(l1Root, "dist", "src", "storage.js")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { signCanonicalDomain }: any = await import(pathToFileURL(join(l1Root, "dist", "src", "crypto.js")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { MAX_SUPPLY_ATOMS }: any = await import(pathToFileURL(join(l1Root, "dist", "src", "types.js")).href);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SEAL_DOMAIN = "zyronchain/open-testnet/restore-summary/v1";
const SUMMARY_FORMAT = "zyron-open-testnet-restore-summary-v1";
const SET_DOMAIN = { validators: "zyronchain/open-testnet/validator-set/v1", oracles: "zyronchain/open-testnet/oracle-set/v1" };
const SNAPSHOT_SECRET = "s2-3-restore-anchor-test-fixture-secret-0123456789";
const CHAIN_ID = "zyron-s23-anchor-testnet-1";

// Expected reason codes. The implementation must use exactly these.
const CODES = {
  anchorMissing: "RESTORE_ANCHOR_MISSING",
  sealMissing: "RESTORE_SEAL_MISSING",
  anchorUnavailable: "RESTORE_ANCHOR_UNAVAILABLE",
  quorumTipUnavailable: "RESTORE_QUORUM_TIP_UNAVAILABLE",
  quorumTipMismatch: "RESTORE_QUORUM_TIP_MISMATCH",
  invalidSignature: "RESTORE_SEAL_INVALID_SIGNATURE",
  unknownKeyId: "RESTORE_SEAL_UNKNOWN_KEY_ID",
  keyRevoked: "RESTORE_SEAL_KEY_REVOKED",
  validatorKey: "RESTORE_SEAL_VALIDATOR_KEY",
  superseded: "RESTORE_SUMMARY_SUPERSEDED",
  replayLowerHeight: "RESTORE_SUMMARY_REPLAY_LOWER_HEIGHT",
  wrongChain: "RESTORE_SUMMARY_WRONG_CHAIN",
  genesisMismatch: "RESTORE_SUMMARY_GENESIS_MISMATCH",
  stale: "RESTORE_SUMMARY_STALE",
  aboveTip: "RESTORE_SUMMARY_ABOVE_TIP",
  tipMismatch: "RESTORE_SUMMARY_TIP_MISMATCH",
  stateMismatch: "RESTORE_SUMMARY_STATE_MISMATCH",
  supplyMismatch: "RESTORE_SUMMARY_SUPPLY_MISMATCH",
  burnMismatch: "RESTORE_SUMMARY_BURN_MISMATCH",
  validatorSetMismatch: "RESTORE_SUMMARY_VALIDATOR_SET_MISMATCH",
  oracleSetMismatch: "RESTORE_SUMMARY_ORACLE_SET_MISMATCH",
  snapshotCorrupt: "RESTORE_SNAPSHOT_CORRUPT"
} as const;

function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function sealMessage(keyId: string, summary: Json): Buffer {
  return Buffer.concat([Buffer.from(SEAL_DOMAIN), Buffer.from([0]), Buffer.from(canonicalJson({ keyId, summary }))]);
}
function summaryDigest(keyId: string, summary: Json): string {
  return createHash("sha256").update(sealMessage(keyId, summary)).digest("hex");
}
function setHash(domain: string, publicKeys: string[]): string {
  return createHash("sha256").update(Buffer.concat([Buffer.from(domain), Buffer.from([0]), Buffer.from(canonicalJson(publicKeys))])).digest("hex");
}

// A TEST FIXTURE Ed25519 summary key, generated at runtime. The keyId says so,
// so it can never be mistaken for the pinned testnet summary key.
interface FixtureKey { keyId: string; publicKey: string; privateKey: KeyObject }
function fixtureSummaryKey(label: string): FixtureKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
  return { keyId: `TEST-FIXTURE-ONLY-${label}-${raw.slice(0, 8)}`, publicKey: raw, privateKey };
}
function seal(key: FixtureKey, summary: Json, keyId = key.keyId): Json {
  return { summary, keyId, signature: edSign(null, sealMessage(keyId, summary), key.privateKey).toString("hex") };
}

// liveTips: the finalized tip hash per height as the live validators report it
// (read from the source network's v2 log, not from the bundle).
interface Fixture { root: string; bundle: Json; expected: Json; impostor: Json; liveTips: string[] }
let fx: Fixture;

async function readBundle(source: string): Promise<Json> {
  const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));
  const keys: Record<string, string> = {};
  for (const file of await readdir(join(source, "keys"))) keys[file.replace(/\.json$/, "")] = (await json(join(source, "keys", file))).privateKey;
  const blocks = (await readFile(join(source, "data-v1", "blocks.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  return { format: "ZYRON-OPEN-TESTNET-STATE-V1", genesis: await json(join(source, "genesis.json")), network: await json(join(source, "network.json")), keys, blocks };
}

// The expected summary is computed from the source network's own validated
// store (standing in for the live chain the summary is sealed from), not from
// the bundle object handed to restoreNetwork.
async function liveSummary(source: string): Promise<Json> {
  const genesis = JSON.parse(await readFile(join(source, "genesis.json"), "utf8"));
  const network = JSON.parse(await readFile(join(source, "network.json"), "utf8"));
  const store = await ChainStore.open(genesis, join(source, "data-v2"));
  const chain = store.chain;
  const total = BigInt(chain.genesisSupplyAtoms());
  const balances = chain.getState().snapshot().accounts.reduce((sum: bigint, account: Json) => sum + BigInt(account.balanceAtoms), 0n);
  const pending = 0n;
  const burned = total - balances - pending;
  // S2-3 criterion 4: fixed 50M supply, balances + pending + burned == total.
  assert.equal(total, BigInt(MAX_SUPPLY_ATOMS), "fixture genesis is not the fixed 50,000,000 ZYN supply");
  assert.ok(burned >= 0n && balances + pending + burned === total, "fixture supply does not reconcile");
  const summary = {
    format: SUMMARY_FORMAT,
    chainId: genesis.chainId,
    genesisHash: network.genesisHash,
    height: chain.height,
    tipHash: chain.tip.hash,
    stateRoot: chain.tip.header.stateRoot,
    totalSupplyAtoms: total.toString(),
    burnedAtoms: burned.toString(),
    validatorSetHash: setHash(SET_DOMAIN.validators, genesis.validators.map((v: Json) => v.publicKey)),
    oracleSetHash: setHash(SET_DOMAIN.oracles, genesis.activityOracles),
    provenance: { publisher: "TEST-FIXTURE-ONLY", workflow: "test/open-testnet-restore-independent-anchor", commit: "0".repeat(40) },
    sealedAtMs: Date.now()
  };
  await store.close?.();
  return summary;
}

before(async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-s23-anchor-"));
  await api.initNetwork(join(root, "source"), CHAIN_ID);
  // A second, independent network under the SAME chain ID (other keys, other
  // genesis): the "wrong genesis / impostor branch" fixture.
  await api.initNetwork(join(root, "impostor"), CHAIN_ID);
  const liveTips = (await readFile(join(root, "source", "data-v2", "blocks.ndjson"), "utf8")).trim().split("\n").map((line) => JSON.parse(line).hash);
  fx = { root, bundle: await readBundle(join(root, "source")), expected: await liveSummary(join(root, "source")), impostor: await readBundle(join(root, "impostor")), liveTips };
});
after(async () => { if (fx) await rm(fx.root, { recursive: true, force: true }); });

let targets = 0;
function target(): string { targets += 1; return join(fx.root, `restored-${targets}`); }
function bundle(): Json { return structuredClone(fx.bundle); }

// A fully honest anchor around a TEST FIXTURE key. Overrides change one thing.
function anchor(options: { key?: FixtureKey; summary?: Json; sealed?: Json; pinned?: Json[]; superseded?: Json[]; quorumTip?: (height: number) => Promise<Json>; calls?: Json } = {}): Json {
  const key = options.key ?? fixtureSummaryKey("honest");
  const summary = options.summary ?? structuredClone(fx.expected);
  const sealed = "sealed" in options ? options.sealed : seal(key, summary);
  const calls = options.calls ?? { readSeal: 0, readSuperseded: 0, readQuorumTip: 0 };
  return {
    pinnedKeys: options.pinned ?? [{ keyId: key.keyId, publicKey: key.publicKey }],
    readSeal: async () => { calls.readSeal += 1; return structuredClone(sealed); },
    readSuperseded: async () => { calls.readSuperseded += 1; return structuredClone(options.superseded ?? []); },
    readQuorumTip: options.quorumTip ?? (async (height: number) => {
      calls.readQuorumTip += 1;
      const tipHash = fx.liveTips[height - 1];
      if (!tipHash) throw new Error(`TEST STUB: the live quorum has no finalized block at height ${height}`);
      return { height, tipHash };
    })
  };
}

// Fail-closed refusal: the given code, never localIo, no completion marker;
// with `beforeWrites` also no key material written.
async function refuses(run: Promise<unknown>, code: string, dir: string, { beforeWrites = false } = {}): Promise<void> {
  await assert.rejects(run, (error: Json) => {
    assert.equal(error?.code, code, `expected refusal ${code}, got ${error?.code ?? "no code"}: ${error?.message}`);
    assert.notEqual(error?.localIo, true, "an anchor/summary refusal must not be treated as a local disk failure");
    return true;
  }, `restore was not refused with ${code}`);
  assert.equal(await api.readNetworkMarker(dir), null, "a refused restore must not be marked complete");
  assert.ok(!existsSync(join(dir, "network.json")), "network.json written by a refused restore");
  if (beforeWrites) assert.ok(!existsSync(join(dir, "keys")), "key material written before the anchor was checked");
}

const restore = (dir: string, b: Json, restoreAnchor?: Json) =>
  api.restoreNetwork(dir, b, CHAIN_ID, restoreAnchor === undefined ? {} : { restoreAnchor });

test("S23-T1 restore-requires-independent-summary: missing anchor or seal is refused; an honest seal is consulted", { timeout: 300_000 }, async () => {
  // Missing anchor: today's call shape (bundle + expectedChainId only).
  let dir = target();
  await refuses(api.restoreNetwork(dir, bundle(), CHAIN_ID), CODES.anchorMissing, dir, { beforeWrites: true });
  dir = target();
  await refuses(api.restoreNetworkWithLocalRetry(dir, bundle(), CHAIN_ID, { delays: [], sleepImpl: async () => {}, log: () => {} }), CODES.anchorMissing, dir, { beforeWrites: true });
  // Anchor configured, nothing sealed.
  dir = target();
  await refuses(restore(dir, bundle(), anchor({ sealed: null })), CODES.sealMissing, dir, { beforeWrites: true });
  // Positive control: the honest seal is read, checked against the superseded
  // record and the live quorum tip, and its provenance is reported.
  const key = fixtureSummaryKey("control");
  const calls = { readSeal: 0, readSuperseded: 0, readQuorumTip: 0 };
  dir = target();
  const restored = await api.restoreNetworkWithLocalRetry(dir, bundle(), CHAIN_ID, { restoreAnchor: anchor({ key, calls }), delays: [], sleepImpl: async () => {}, log: () => {} });
  assert.ok(calls.readSeal >= 1, "the independent seal was never read");
  assert.ok(calls.readSuperseded >= 1, "the superseded record was never read");
  assert.ok(calls.readQuorumTip >= 1, "the live quorum tip was never consulted");
  assert.equal(restored.height, fx.expected.height);
  assert.equal(restored.tipHash, fx.expected.tipHash);
  assert.deepEqual(restored.anchor, { keyId: key.keyId, summaryDigest: summaryDigest(key.keyId, fx.expected) }, "restore does not report which seal it was bound to");
  assert.ok(await api.readNetworkMarker(dir));
});

test("S23-T2 restore-rejects-wrong-chain-summary", { timeout: 300_000 }, async () => {
  const dir = target();
  await refuses(restore(dir, bundle(), anchor({ summary: { ...fx.expected, chainId: "zyron-other-testnet-1" } })), CODES.wrongChain, dir, { beforeWrites: true });
});

test("S23-T3 restore-rejects-stale-or-above-tip-summary", { timeout: 300_000 }, async () => {
  const blocks = fx.bundle.blocks;
  // Summary older than the snapshot tip (a stale summary).
  let dir = target();
  const older = { ...fx.expected, height: blocks.length - 1, tipHash: blocks.at(-2).hash, stateRoot: blocks.at(-2).header.stateRoot };
  await refuses(restore(dir, bundle(), anchor({ summary: older })), CODES.stale, dir, { beforeWrites: true });
  // Summary above the snapshot tip: the snapshot is the stale side.
  dir = target();
  const ahead = { ...fx.expected, height: blocks.length + 30, tipHash: "ab".repeat(32) };
  await refuses(restore(dir, bundle(), anchor({ summary: ahead, quorumTip: async () => ({ height: ahead.height, tipHash: ahead.tipHash }) })), CODES.aboveTip, dir, { beforeWrites: true });
});

test("S23-T4 restore-rejects-tip-or-state-root-mismatch", { timeout: 300_000 }, async () => {
  const blocks = fx.bundle.blocks;
  // Mutated tip hash; the live quorum agrees with the (other) sealed tip.
  let dir = target();
  const otherTip = { ...fx.expected, tipHash: "cd".repeat(32) };
  await refuses(restore(dir, bundle(), anchor({ summary: otherTip, quorumTip: async () => ({ height: otherTip.height, tipHash: otherTip.tipHash }) })), CODES.tipMismatch, dir);
  // Mixed-height fields: height of the tip, hash of the block below it.
  dir = target();
  const mixed = { ...fx.expected, tipHash: blocks.at(-2).hash };
  await refuses(restore(dir, bundle(), anchor({ summary: mixed, quorumTip: async () => ({ height: mixed.height, tipHash: mixed.tipHash }) })), CODES.tipMismatch, dir);
  // Mutated state digest.
  dir = target();
  await refuses(restore(dir, bundle(), anchor({ summary: { ...fx.expected, stateRoot: "ef".repeat(32) } })), CODES.stateMismatch, dir);
});

test("S23-T5 restore-rejects-supply-or-burn-mismatch", { timeout: 300_000 }, async () => {
  const b = bundle();
  const genesisBefore = structuredClone(b.genesis);
  let dir = target();
  await refuses(restore(dir, b, anchor({ summary: { ...fx.expected, totalSupplyAtoms: (BigInt(fx.expected.totalSupplyAtoms) + 1n).toString() } })), CODES.supplyMismatch, dir);
  dir = target();
  await refuses(restore(dir, b, anchor({ summary: { ...fx.expected, burnedAtoms: (BigInt(fx.expected.burnedAtoms) + 1n).toString() } })), CODES.burnMismatch, dir);
  // No change to the supply tables: the genesis allocations are untouched.
  assert.deepEqual(b.genesis, genesisBefore, "restore changed the genesis allocations");
});

test("S23-T6 restore-rejects-validator-or-oracle-set-mismatch", { timeout: 300_000 }, async () => {
  const genesis = fx.bundle.genesis;
  const other = fixtureSummaryKey("not-a-validator").publicKey;
  const swappedValidators = genesis.validators.map((v: Json, i: number) => (i === 0 ? other : v.publicKey));
  let dir = target();
  await refuses(restore(dir, bundle(), anchor({ summary: { ...fx.expected, validatorSetHash: setHash(SET_DOMAIN.validators, swappedValidators) } })), CODES.validatorSetMismatch, dir, { beforeWrites: true });
  const swappedOracles = genesis.activityOracles.map((o: string, i: number) => (i === 0 ? other : o));
  dir = target();
  await refuses(restore(dir, bundle(), anchor({ summary: { ...fx.expected, oracleSetHash: setHash(SET_DOMAIN.oracles, swappedOracles) } })), CODES.oracleSetMismatch, dir, { beforeWrites: true });
  // A self-consistent impostor bundle under the same chain ID (own genesis,
  // keys and history) is refused against the trusted summary.
  dir = target();
  await refuses(restore(dir, structuredClone(fx.impostor), anchor()), CODES.genesisMismatch, dir, { beforeWrites: true });
});

test("S23-T7 restore-rejects-corrupt-or-truncated-snapshot", { timeout: 300_000 }, async () => {
  const sealed: Buffer = api.sealSnapshot(fx.bundle, SNAPSHOT_SECRET);
  assert.deepEqual(api.openSnapshot(sealed, SNAPSHOT_SECRET).network, fx.bundle.network, "fixture seal opens");
  const headerLength = Buffer.byteLength("ZYRON-OPEN-TESTNET-STATE-V1\n");
  const truncated = sealed.subarray(0, sealed.length - 64);
  const badTag = Buffer.from(sealed);
  badTag.writeUInt8(badTag.readUInt8(headerLength + 12) ^ 0x01, headerLength + 12);
  for (const [label, bytes] of [["truncated ciphertext", truncated], ["bad GCM tag", badTag]] as const) {
    assert.throws(() => api.openSnapshot(bytes, SNAPSHOT_SECRET), (error: Json) => {
      assert.equal(error?.code, CODES.snapshotCorrupt, `${label}: expected ${CODES.snapshotCorrupt}, got ${error?.code ?? "no code"}: ${error?.message}`);
      return true;
    });
  }
  // Tampered history (one attestation signature) with an honest seal.
  const tampered = bundle();
  const vote = tampered.blocks[49].attestations[0];
  vote.signature = (vote.signature[0] === "0" ? "1" : "0") + vote.signature.slice(1);
  const dir = target();
  await refuses(restore(dir, tampered, anchor()), CODES.snapshotCorrupt, dir);
});

test("S23-T8 restore-rejects-unavailable-independent-anchor", { timeout: 300_000 }, async () => {
  // A network-style failure (it has a syscall) must not be classed as a local
  // disk error, and there is no snapshot-only fallback.
  const unreachable = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED", syscall: "connect" });
  let dir = target();
  const sealDown = { ...anchor(), readSeal: async () => { throw unreachable(); } };
  let attempts = 0;
  const counted = (d: string, b: Json, id: string, opts: Json) => { attempts += 1; return api.restoreNetwork(d, b, id, opts); };
  await refuses(api.restoreNetworkWithLocalRetry(dir, bundle(), CHAIN_ID, { restoreAnchor: sealDown, restore: counted, delays: [0, 0], sleepImpl: async () => {}, log: () => {}, moveAside: async () => false }), CODES.anchorUnavailable, dir, { beforeWrites: true });
  assert.equal(attempts, 1, "an unavailable anchor was retried as a local disk failure");
  dir = target();
  await refuses(restore(dir, bundle(), { ...anchor(), readSuperseded: async () => { throw unreachable(); } }), CODES.anchorUnavailable, dir, { beforeWrites: true });
  dir = target();
  await refuses(restore(dir, bundle(), anchor({ quorumTip: async () => { throw unreachable(); } })), CODES.quorumTipUnavailable, dir, { beforeWrites: true });
});

// ---- T1 trust-anchor cases (Patron + Security, Nov 9) ----------------------

test("S23-T9 restore-rejects-tampered-summary-field", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("tamper");
  // Every summary field is covered by the signature: change each one after signing.
  for (const field of Object.keys(fx.expected)) {
    const sealed = seal(key, fx.expected);
    sealed.summary = { ...sealed.summary, [field]: field === "height" || field === "sealedAtMs" ? sealed.summary[field] + 1 : field === "provenance" ? { ...sealed.summary.provenance, commit: "1".repeat(40) } : `${sealed.summary[field]}0` };
    const dir = target();
    await refuses(restore(dir, bundle(), anchor({ key, sealed })), CODES.invalidSignature, dir, { beforeWrites: true });
  }
  // The keyId is covered too: a valid signature moved to another pinned keyId.
  const second = fixtureSummaryKey("second");
  const moved = { ...seal(key, fx.expected), keyId: second.keyId };
  const dir = target();
  await refuses(restore(dir, bundle(), anchor({ key, sealed: moved, pinned: [{ keyId: key.keyId, publicKey: key.publicKey }, { keyId: second.keyId, publicKey: key.publicKey }] })), CODES.invalidSignature, dir, { beforeWrites: true });
});

test("S23-T10 restore-rejects-wrong-key-id", { timeout: 300_000 }, async () => {
  const pinned = fixtureSummaryKey("pinned");
  const unpinned = fixtureSummaryKey("unpinned");
  // Signed by a key whose keyId is not pinned.
  let dir = target();
  await refuses(restore(dir, bundle(), anchor({ key: pinned, sealed: seal(unpinned, fx.expected) })), CODES.unknownKeyId, dir, { beforeWrites: true });
  // Unpinned key claiming an unknown keyId of its own choosing.
  dir = target();
  await refuses(restore(dir, bundle(), anchor({ key: pinned, sealed: seal(unpinned, fx.expected, "TEST-FIXTURE-ONLY-made-up") })), CODES.unknownKeyId, dir, { beforeWrites: true });
});

test("S23-T11 restore-rejects-revoked-key", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("revoked");
  const dir = target();
  await refuses(restore(dir, bundle(), anchor({ key, pinned: [{ keyId: key.keyId, publicKey: key.publicKey, revoked: true }] })), CODES.keyRevoked, dir, { beforeWrites: true });
});

test("S23-T12 restore-rejects-superseded-summary", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("superseded");
  const digest = summaryDigest(key.keyId, fx.expected);
  // The summary itself is listed as superseded.
  let dir = target();
  await refuses(restore(dir, bundle(), anchor({ key, superseded: [{ summaryDigest: digest, height: fx.expected.height, tipHash: fx.expected.tipHash }] })), CODES.superseded, dir, { beforeWrites: true });
  // Its tip is listed as superseded under another summary (e.g. a rolled-back branch).
  dir = target();
  await refuses(restore(dir, bundle(), anchor({ key, superseded: [{ summaryDigest: "00".repeat(32), height: fx.expected.height, tipHash: fx.expected.tipHash }] })), CODES.superseded, dir, { beforeWrites: true });
});

test("S23-T13 restore-rejects-lower-height-replay", { timeout: 300_000 }, async () => {
  // A validly sealed, not-superseded summary below the highest height the
  // append-only record has already seen is a replay of an older seal.
  const key = fixtureSummaryKey("replay");
  const dir = target();
  await refuses(restore(dir, bundle(), anchor({ key, superseded: [{ summaryDigest: "11".repeat(32), height: fx.expected.height + 50, tipHash: "22".repeat(32) }] })), CODES.replayLowerHeight, dir, { beforeWrites: true });
});

test("S23-T14 restore-rejects-seal-signed-by-validator-key", { timeout: 300_000 }, async () => {
  // A key from the snapshot's own validator set (shipped inside the bundle)
  // can never be the trust anchor, even if the seal claims its keyId.
  const validatorPrivate = fx.bundle.keys.v1;
  const validatorPublic = fx.bundle.genesis.validators[0].publicKey;
  const signature = signCanonicalDomain(SEAL_DOMAIN, { keyId: validatorPublic, summary: fx.expected }, validatorPrivate);
  const pinnedFixture = fixtureSummaryKey("pinned");
  let dir = target();
  await refuses(restore(dir, bundle(), anchor({ key: pinnedFixture, sealed: { summary: fx.expected, keyId: validatorPublic, signature } })), CODES.validatorKey, dir, { beforeWrites: true });
  // Also when a validator key was (mis)pinned.
  dir = target();
  await refuses(restore(dir, bundle(), anchor({ key: pinnedFixture, sealed: { summary: fx.expected, keyId: validatorPublic, signature }, pinned: [{ keyId: pinnedFixture.keyId, publicKey: pinnedFixture.publicKey }, { keyId: validatorPublic, publicKey: validatorPublic }] })), CODES.validatorKey, dir, { beforeWrites: true });
});

test("S23-T15 expected summary comes from a live quorum tip match, never from the snapshot", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("quorum");
  // A correctly sealed summary that matches the snapshot exactly, but the live
  // quorum reports another tip at that height (the snapshot's branch was rolled back).
  let dir = target();
  await refuses(restore(dir, bundle(), anchor({ key, quorumTip: async (height: number) => ({ height, tipHash: "34".repeat(32) }) })), CODES.quorumTipMismatch, dir, { beforeWrites: true });
  // A summary shipped inside the bundle is never used: with no external seal
  // the restore is refused even though the bundle carries a valid one.
  const carrying = bundle();
  carrying.restoreSummary = seal(key, fx.expected);
  dir = target();
  await refuses(restore(dir, carrying, anchor({ key, sealed: null })), CODES.sealMissing, dir, { beforeWrites: true });
});
