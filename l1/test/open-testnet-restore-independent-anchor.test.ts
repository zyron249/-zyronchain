// S2-3 (Red Team Session 2, Nov 3; Security acceptance gaps, Nov 9): a restore
// must be bound to an independently authenticated expected summary, not to a
// summary derived from the snapshot being restored.
//
// FAILING FIRST BY DESIGN. These tests were written before any implementation
// and fail on main. Patron's policy (Nov 9): no red merges to main and no
// todo/skip/STRICT gates, so this file only lands stacked with the green
// implementation PR. No production code is changed here.
//
// Trust anchor (Patron's "T1", confirmed by Security on Nov 9): an externally
// sealed summary for open-testnet backups only, signed with Ed25519 by a
// dedicated testnet summary key whose public key is pinned in the repo; an
// append-only "superseded" record; an append-only high-water record; and a
// match against the tip a live quorum reports for the summary height. The
// expected summary is never taken from the snapshot being restored.
//
// Every key in this file is a TEST FIXTURE generated at runtime inside the
// test (keyIds start with TEST-FIXTURE-ONLY-), except the public RFC 8032
// section 7.1 TEST 1 vector key. None is, or may be used as, the pinned key.
//
// ---- Contract the implementation has to meet --------------------------------
//
//   restoreNetwork(dir, bundle, expectedChainId, { onProgress, restoreAnchor })
//   restoreNetworkWithLocalRetry(dir, bundle, expectedChainId, { ..., restoreAnchor })  // forwards it
//   verifyRestoreSeal(raw, { pinnedKeys }) -> { keyId, summary, summaryDigest }       // exported
//
//   restoreAnchor = {
//     pinnedKeys: [{ keyId, publicKey, revoked, supersededAtHeight? }],
//     readSeal(): Promise<string | null>                 // the raw seal text
//     readSuperseded(): Promise<[{ summaryDigest, height, tipHash }]>   // append-only
//     readHighWater(): Promise<{ height, summaryDigest }> // highest NON-superseded seal, append-only
//     readQuorumTip(height): Promise<{ height, tipHash }>
//     timeoutMs?: number                                 // each read; a hang fails closed
//   }
//
//   Pinned key entry (else RESTORE_ANCHOR_CONFIG_INVALID, before any write):
//     exact keys { keyId, publicKey, revoked } plus optional supersededAtHeight;
//     keyId ^[A-Za-z0-9._-]{1,64}$; publicKey = raw 32-byte Ed25519, 64 lowercase
//     hex; revoked a strict boolean; supersededAtHeight a safe non-negative
//     integer; no duplicate keyId and no duplicate publicKey; at least one entry.
//   Revoked key: no seal made with it is accepted.
//   Superseded key (rotated out): a seal made with it is accepted only for a
//     summary height strictly below supersededAtHeight.
//
//   Raw seal = canonicalJson({ keyId, signature, summary }) (l1/src/codec.ts),
//     printable ASCII only. Not a string / not JSON / not an object ->
//     RESTORE_SEAL_MALFORMED. Otherwise canonicalJson(JSON.parse(raw)) must equal
//     raw (no duplicate keys, no whitespace, sorted keys) and the schema must
//     hold, else RESTORE_SEAL_SCHEMA_INVALID:
//       top level exactly { keyId, signature, summary }; keyId as above;
//       summary exactly { format, chainId, genesisHash, height, tipHash, stateRoot,
//         totalSupplyAtoms, burnedAtoms, validatorSetHash, oracleSetHash,
//         provenance, sealedAtMs };
//       format === "zyron-open-testnet-restore-summary-v1"; chainId ^[a-z0-9][a-z0-9-]{0,63}$;
//       hashes 32-byte lowercase hex; height and sealedAtMs safe non-negative
//       integers; atoms ^(0|[1-9][0-9]*)$ strings; provenance exactly
//       { commit (40 lowercase hex), publisher, workflow (printable ASCII 1..128) }.
//     The signature field must be a string; its encoding (64 bytes, 128
//     lowercase hex) is judged by the signature check: RESTORE_SEAL_INVALID_SIGNATURE.
//   Signed message = "zyronchain/open-testnet/restore-summary/v1" || 0x00 ||
//     canonicalJson({ keyId, summary }); summaryDigest = sha256(message), hex.
//   Validator/oracle/faucet keys are never trust anchors: a seal whose keyId is
//     a validator, oracle or faucet address/public key, or a pinned key whose
//     publicKey is the x-coordinate of one of those keys (checked against the
//     sets the summary binds), -> RESTORE_SEAL_VALIDATOR_KEY.
//
// Every refusal is fail-closed: the promise rejects with an Error whose `code`
// is the listed reason, the error is never marked `localIo` (not retried as a
// disk failure), and the target directory is left absent or empty (no
// network.json, genesis.json, keys/ or data-*).
import assert from "node:assert/strict";
import { createHash, createPrivateKey, generateKeyPairSync, sign as edSign, type KeyObject } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
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
const { signCanonicalDomain, publicKeyFromPrivate }: any = await import(pathToFileURL(join(l1Root, "dist", "src", "crypto.js")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { canonicalJson }: any = await import(pathToFileURL(join(l1Root, "dist", "src", "codec.js")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { MAX_SUPPLY_ATOMS }: any = await import(pathToFileURL(join(l1Root, "dist", "src", "types.js")).href);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const SEAL_DOMAIN = "zyronchain/open-testnet/restore-summary/v1";
const SUMMARY_FORMAT = "zyron-open-testnet-restore-summary-v1";
const SET_DOMAIN = { validators: "zyronchain/open-testnet/validator-set/v1", oracles: "zyronchain/open-testnet/oracle-set/v1" };
const SNAPSHOT_SECRET = "s2-3-restore-anchor-test-fixture-secret-0123456789";
const CHAIN_ID = "zyron-s23-anchor-testnet-1";
const READ_TIMEOUT_MS = 500;

// Expected reason codes. The implementation must use exactly these.
const CODES = {
  anchorMissing: "RESTORE_ANCHOR_MISSING",
  anchorConfigInvalid: "RESTORE_ANCHOR_CONFIG_INVALID",
  anchorUnavailable: "RESTORE_ANCHOR_UNAVAILABLE",
  anchorTimeout: "RESTORE_ANCHOR_TIMEOUT",
  sealMissing: "RESTORE_SEAL_MISSING",
  sealMalformed: "RESTORE_SEAL_MALFORMED",
  sealSchemaInvalid: "RESTORE_SEAL_SCHEMA_INVALID",
  invalidSignature: "RESTORE_SEAL_INVALID_SIGNATURE",
  unknownKeyId: "RESTORE_SEAL_UNKNOWN_KEY_ID",
  keyRevoked: "RESTORE_SEAL_KEY_REVOKED",
  keySuperseded: "RESTORE_SEAL_KEY_SUPERSEDED",
  validatorKey: "RESTORE_SEAL_VALIDATOR_KEY",
  superseded: "RESTORE_SUMMARY_SUPERSEDED",
  replayLowerHeight: "RESTORE_SUMMARY_REPLAY_LOWER_HEIGHT",
  highWaterConflict: "RESTORE_SUMMARY_HIGH_WATER_CONFLICT",
  wrongChain: "RESTORE_SUMMARY_WRONG_CHAIN",
  genesisMismatch: "RESTORE_SUMMARY_GENESIS_MISMATCH",
  validatorSetMismatch: "RESTORE_SUMMARY_VALIDATOR_SET_MISMATCH",
  oracleSetMismatch: "RESTORE_SUMMARY_ORACLE_SET_MISMATCH",
  stale: "RESTORE_SUMMARY_STALE",
  aboveTip: "RESTORE_SUMMARY_ABOVE_TIP",
  quorumTipUnavailable: "RESTORE_QUORUM_TIP_UNAVAILABLE",
  quorumTipTimeout: "RESTORE_QUORUM_TIP_TIMEOUT",
  quorumTipMismatch: "RESTORE_QUORUM_TIP_MISMATCH",
  tipMismatch: "RESTORE_SUMMARY_TIP_MISMATCH",
  stateMismatch: "RESTORE_SUMMARY_STATE_MISMATCH",
  supplyMismatch: "RESTORE_SUMMARY_SUPPLY_MISMATCH",
  burnMismatch: "RESTORE_SUMMARY_BURN_MISMATCH",
  snapshotCorrupt: "RESTORE_SNAPSHOT_CORRUPT"
} as const;

// ---- encoding helpers (summaries travel as their exact canonical text) -------

interface MessageOptions { domain?: string | null; separator?: boolean; withKeyId?: boolean }
function sealMessage(keyId: string, summaryText: string, { domain = SEAL_DOMAIN, separator = true, withKeyId = true }: MessageOptions = {}): Buffer {
  const body = withKeyId ? `{"keyId":${JSON.stringify(keyId)},"summary":${summaryText}}` : summaryText;
  return Buffer.concat([Buffer.from(domain ?? ""), domain !== null && separator ? Buffer.from([0]) : Buffer.alloc(0), Buffer.from(body)]);
}
function digestOf(keyId: string, summaryText: string): string {
  return createHash("sha256").update(sealMessage(keyId, summaryText)).digest("hex");
}
function setHash(domain: string, publicKeys: string[]): string {
  return createHash("sha256").update(Buffer.concat([Buffer.from(domain), Buffer.from([0]), Buffer.from(canonicalJson(publicKeys))])).digest("hex");
}

// A TEST FIXTURE Ed25519 summary key, generated at runtime.
interface FixtureKey { keyId: string; publicKey: string; privateKey: KeyObject }
function fixtureSummaryKey(label: string): FixtureKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url").toString("hex");
  return { keyId: `TEST-FIXTURE-ONLY-${label}-${raw.slice(0, 8)}`, publicKey: raw, privateKey };
}
function pin(key: FixtureKey, extra: Json = {}): Json { return { keyId: key.keyId, publicKey: key.publicKey, revoked: false, ...extra }; }
function rawSeal(keyId: string, signatureHex: string, summaryText: string): string {
  return `{"keyId":${JSON.stringify(keyId)},"signature":${JSON.stringify(signatureHex)},"summary":${summaryText}}`;
}
// Honest seal over `summaryText`; `signAs` signs a different keyId than the one
// presented, `message` changes the signed encoding.
function seal(key: FixtureKey, summary: Json | string, { signAs, message }: { signAs?: string; message?: MessageOptions } = {}): string {
  const text = typeof summary === "string" ? summary : canonicalJson(summary);
  const signature = edSign(null, sealMessage(signAs ?? key.keyId, text, message), key.privateKey).toString("hex");
  return rawSeal(key.keyId, signature, text);
}

// ---- fixture -------------------------------------------------------------------

// liveTips: finalized tip hash per height as the live validators report it
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
  // The protocol has no escrow state, so pending is always 0 (supply-report.ts);
  // a non-zero pending cannot be produced. The invariant is asserted instead.
  const pending = 0n;
  const burned = total - balances - pending;
  assert.equal(total, BigInt(MAX_SUPPLY_ATOMS), "fixture genesis is not the fixed 50,000,000 ZYN supply");
  assert.ok(burned >= 0n, "fixture supply does not reconcile");
  assert.equal(balances + pending + burned, BigInt(MAX_SUPPLY_ATOMS), "balances + pending + burned != MAX_SUPPLY_ATOMS");
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
const hang = () => new Promise<never>(() => {});

interface AnchorOptions {
  key?: FixtureKey; summary?: Json; raw?: Json; pinned?: Json[]; superseded?: Json[];
  highWater?: Json; quorumTip?: (height: number) => Promise<Json>; calls?: Json;
}
// A fully honest anchor around a TEST FIXTURE key. Overrides change one thing.
// The default high-water mark is the seal being presented.
function anchor(options: AnchorOptions = {}): Json {
  const key = options.key ?? fixtureSummaryKey("honest");
  const summary = options.summary ?? structuredClone(fx.expected);
  const raw = "raw" in options ? options.raw : seal(key, summary);
  const calls = options.calls ?? { readSeal: 0, readSuperseded: 0, readHighWater: 0, readQuorumTip: 0 };
  const highWater = options.highWater ?? { height: summary.height, summaryDigest: digestOf(key.keyId, canonicalJson(summary)) };
  return {
    pinnedKeys: options.pinned ?? [pin(key)],
    timeoutMs: READ_TIMEOUT_MS,
    readSeal: async () => { calls.readSeal += 1; return raw; },
    readSuperseded: async () => { calls.readSuperseded += 1; return structuredClone(options.superseded ?? []); },
    readHighWater: async () => { calls.readHighWater += 1; return structuredClone(highWater); },
    readQuorumTip: options.quorumTip ?? (async (height: number) => {
      calls.readQuorumTip += 1;
      const tipHash = fx.liveTips[height - 1];
      if (!tipHash) throw new Error(`TEST STUB: the live quorum has no finalized block at height ${height}`);
      return { height, tipHash };
    })
  };
}

// Fail-closed refusal: the given code, never localIo, and the target directory
// absent or empty (L1: no network.json, genesis.json, keys/ or data-*).
async function refuses(run: Promise<unknown>, code: string, dir: string, label = ""): Promise<void> {
  await assert.rejects(run, (error: Json) => {
    assert.equal(error?.code, code, `${label}: expected refusal ${code}, got ${error?.code ?? "no code"}: ${error?.message}`);
    assert.notEqual(error?.localIo, true, `${label}: an anchor/summary refusal must not be treated as a local disk failure`);
    return true;
  }, `${label}: restore was not refused with ${code}`);
  assert.equal(await api.readNetworkMarker(dir), null, `${label}: a refused restore must not be marked complete`);
  const left = existsSync(dir) ? readdirSync(dir) : [];
  assert.deepEqual(left, [], `${label}: a refused restore left files behind: ${left.join(", ")}`);
}

const restore = (dir: string, b: Json, restoreAnchor?: Json) =>
  api.restoreNetwork(dir, b, CHAIN_ID, restoreAnchor === undefined ? {} : { restoreAnchor });
async function refusesWith(restoreAnchor: Json, code: string, label = "", b: Json = bundle()): Promise<void> {
  const dir = target();
  await refuses(restore(dir, b, restoreAnchor), code, dir, label);
}
async function succeedsWith(restoreAnchor: Json, key: FixtureKey, summaryText: string, label: string, b: Json = bundle()): Promise<Json> {
  const dir = target();
  const restored = await restore(dir, b, restoreAnchor);
  assert.deepEqual(restored?.anchor, { keyId: key.keyId, summaryDigest: digestOf(key.keyId, summaryText) }, `${label}: restore does not report the seal it was bound to`);
  assert.ok(await api.readNetworkMarker(dir), `${label}: restore not marked complete`);
  return restored;
}

// ---- Security checklist S23-T1..T8 --------------------------------------------

test("S23-T1 restore-requires-independent-summary: missing anchor or seal is refused; an honest seal is consulted", { timeout: 300_000 }, async () => {
  // Missing anchor: today's call shape (bundle + expectedChainId only).
  let dir = target();
  await refuses(api.restoreNetwork(dir, bundle(), CHAIN_ID), CODES.anchorMissing, dir, "restoreNetwork");
  dir = target();
  await refuses(api.restoreNetworkWithLocalRetry(dir, bundle(), CHAIN_ID, { delays: [], sleepImpl: async () => {}, log: () => {} }), CODES.anchorMissing, dir, "wrapper");
  // Anchor configured, nothing sealed.
  await refusesWith(anchor({ raw: null }), CODES.sealMissing, "no seal");
  // Positive control: every independent source is read and the provenance is reported.
  const key = fixtureSummaryKey("control");
  const calls = { readSeal: 0, readSuperseded: 0, readHighWater: 0, readQuorumTip: 0 };
  dir = target();
  const restored = await api.restoreNetworkWithLocalRetry(dir, bundle(), CHAIN_ID, { restoreAnchor: anchor({ key, calls }), delays: [], sleepImpl: async () => {}, log: () => {} });
  assert.ok(calls.readSeal >= 1, "the independent seal was never read");
  assert.ok(calls.readSuperseded >= 1, "the superseded record was never read");
  assert.ok(calls.readHighWater >= 1, "the high-water record was never read");
  assert.ok(calls.readQuorumTip >= 1, "the live quorum tip was never consulted");
  assert.equal(restored.height, fx.expected.height);
  assert.equal(restored.tipHash, fx.expected.tipHash);
  assert.deepEqual(restored.anchor, { keyId: key.keyId, summaryDigest: digestOf(key.keyId, canonicalJson(fx.expected)) }, "restore does not report which seal it was bound to");
  assert.ok(await api.readNetworkMarker(dir));
});

test("S23-T2 restore-rejects-wrong-chain-summary", { timeout: 300_000 }, async () => {
  await refusesWith(anchor({ summary: { ...fx.expected, chainId: "zyron-other-testnet-1" } }), CODES.wrongChain, "wrong chain");
});

test("S23-T3 restore-rejects-stale-or-above-tip-summary", { timeout: 300_000 }, async () => {
  const blocks = fx.bundle.blocks;
  // Summary older than the snapshot tip (a stale summary).
  const older = { ...fx.expected, height: blocks.length - 1, tipHash: blocks.at(-2).hash, stateRoot: blocks.at(-2).header.stateRoot };
  await refusesWith(anchor({ summary: older }), CODES.stale, "stale");
  // Summary above the snapshot tip: the snapshot is the stale side.
  const ahead = { ...fx.expected, height: blocks.length + 30, tipHash: "ab".repeat(32) };
  await refusesWith(anchor({ summary: ahead, quorumTip: async () => ({ height: ahead.height, tipHash: ahead.tipHash }) }), CODES.aboveTip, "above tip");
});

test("S23-T4 restore-rejects-tip-or-state-root-mismatch", { timeout: 300_000 }, async () => {
  const blocks = fx.bundle.blocks;
  // Mutated tip hash; the live quorum agrees with the (other) sealed tip.
  const otherTip = { ...fx.expected, tipHash: "cd".repeat(32) };
  await refusesWith(anchor({ summary: otherTip, quorumTip: async () => ({ height: otherTip.height, tipHash: otherTip.tipHash }) }), CODES.tipMismatch, "tip");
  // Mixed-height fields: height of the tip, hash of the block below it.
  const mixed = { ...fx.expected, tipHash: blocks.at(-2).hash };
  await refusesWith(anchor({ summary: mixed, quorumTip: async () => ({ height: mixed.height, tipHash: mixed.tipHash }) }), CODES.tipMismatch, "mixed height");
  // Mutated state digest.
  await refusesWith(anchor({ summary: { ...fx.expected, stateRoot: "ef".repeat(32) } }), CODES.stateMismatch, "state root");
});

test("S23-T5 restore-rejects-supply-or-burn-mismatch", { timeout: 300_000 }, async () => {
  const b = bundle();
  const genesisBefore = structuredClone(b.genesis);
  await refusesWith(anchor({ summary: { ...fx.expected, totalSupplyAtoms: (BigInt(fx.expected.totalSupplyAtoms) + 1n).toString() } }), CODES.supplyMismatch, "supply", b);
  await refusesWith(anchor({ summary: { ...fx.expected, burnedAtoms: (BigInt(fx.expected.burnedAtoms) + 1n).toString() } }), CODES.burnMismatch, "burn", b);
  // No change to the supply tables: the genesis allocations are untouched.
  assert.deepEqual(b.genesis, genesisBefore, "restore changed the genesis allocations");
  assert.equal(BigInt(fx.expected.totalSupplyAtoms), BigInt(MAX_SUPPLY_ATOMS));
});

test("S23-T6 restore-rejects-validator-or-oracle-set-mismatch", { timeout: 300_000 }, async () => {
  const genesis = fx.bundle.genesis;
  const other = fixtureSummaryKey("not-a-validator").publicKey;
  const swappedValidators = genesis.validators.map((v: Json, i: number) => (i === 0 ? other : v.publicKey));
  await refusesWith(anchor({ summary: { ...fx.expected, validatorSetHash: setHash(SET_DOMAIN.validators, swappedValidators) } }), CODES.validatorSetMismatch, "validator set");
  const swappedOracles = genesis.activityOracles.map((o: string, i: number) => (i === 0 ? other : o));
  await refusesWith(anchor({ summary: { ...fx.expected, oracleSetHash: setHash(SET_DOMAIN.oracles, swappedOracles) } }), CODES.oracleSetMismatch, "oracle set");
  // A self-consistent impostor bundle under the same chain ID (own genesis,
  // keys and history) is refused against the trusted summary.
  await refusesWith(anchor(), CODES.genesisMismatch, "impostor", structuredClone(fx.impostor));
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
  await refusesWith(anchor(), CODES.snapshotCorrupt, "tampered history", tampered);
});

test("S23-T8 restore-rejects-unavailable-independent-anchor", { timeout: 300_000 }, async () => {
  // A network-style failure (it has a syscall) must not be classed as a local
  // disk error, and there is no snapshot-only fallback.
  const unreachable = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:9"), { code: "ECONNREFUSED", syscall: "connect" });
  const dir = target();
  const sealDown = { ...anchor(), readSeal: async () => { throw unreachable(); } };
  let attempts = 0;
  const counted = (d: string, b: Json, id: string, opts: Json) => { attempts += 1; return api.restoreNetwork(d, b, id, opts); };
  await refuses(api.restoreNetworkWithLocalRetry(dir, bundle(), CHAIN_ID, { restoreAnchor: sealDown, restore: counted, delays: [0, 0], sleepImpl: async () => {}, log: () => {}, moveAside: async () => false }), CODES.anchorUnavailable, dir, "seal unreachable");
  assert.equal(attempts, 1, "an unavailable anchor was retried as a local disk failure");
  await refusesWith({ ...anchor(), readSuperseded: async () => { throw unreachable(); } }, CODES.anchorUnavailable, "superseded unreachable");
  await refusesWith({ ...anchor(), readHighWater: async () => { throw unreachable(); } }, CODES.anchorUnavailable, "high-water unreachable");
  await refusesWith(anchor({ quorumTip: async () => { throw unreachable(); } }), CODES.quorumTipUnavailable, "quorum unreachable");
});

// ---- T1 trust-anchor cases (Patron + Security, Nov 9) -------------------------

test("S23-T9 restore-rejects-tampered-summary-field", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("tamper");
  const flipHex = (hex: string) => hex.slice(0, -1) + (hex.endsWith("0") ? "1" : "0");
  // Each schema-valid change made after signing breaks the signature. (`format`
  // is a constant, so any change to it is a schema refusal, see S23-T22.)
  const tampers: Record<string, (s: Json) => Json> = {
    chainId: (s) => ({ ...s, chainId: `${s.chainId}x` }),
    genesisHash: (s) => ({ ...s, genesisHash: flipHex(s.genesisHash) }),
    height: (s) => ({ ...s, height: s.height + 1 }),
    tipHash: (s) => ({ ...s, tipHash: flipHex(s.tipHash) }),
    stateRoot: (s) => ({ ...s, stateRoot: flipHex(s.stateRoot) }),
    totalSupplyAtoms: (s) => ({ ...s, totalSupplyAtoms: (BigInt(s.totalSupplyAtoms) + 1n).toString() }),
    burnedAtoms: (s) => ({ ...s, burnedAtoms: (BigInt(s.burnedAtoms) + 1n).toString() }),
    validatorSetHash: (s) => ({ ...s, validatorSetHash: flipHex(s.validatorSetHash) }),
    oracleSetHash: (s) => ({ ...s, oracleSetHash: flipHex(s.oracleSetHash) }),
    provenance: (s) => ({ ...s, provenance: { ...s.provenance, commit: flipHex(s.provenance.commit) } }),
    sealedAtMs: (s) => ({ ...s, sealedAtMs: s.sealedAtMs + 1 })
  };
  assert.deepEqual(Object.keys(tampers).sort(), Object.keys(fx.expected).filter((k) => k !== "format").sort(), "every summary field except the constant format is tampered");
  for (const [field, change] of Object.entries(tampers)) {
    const honest = JSON.parse(seal(key, fx.expected));
    const tamperedText = canonicalJson(change(honest.summary));
    await refusesWith(anchor({ key, raw: rawSeal(key.keyId, honest.signature, tamperedText) }), CODES.invalidSignature, `tampered ${field}`);
  }
});

test("S23-T10 restore-rejects-wrong-key-id", { timeout: 300_000 }, async () => {
  const pinned = fixtureSummaryKey("pinned");
  const unpinned = fixtureSummaryKey("unpinned");
  // Signed by a key whose keyId is not pinned.
  await refusesWith(anchor({ key: pinned, raw: seal(unpinned, fx.expected) }), CODES.unknownKeyId, "unpinned key");
  // Unpinned key claiming an unknown keyId of its own choosing.
  const madeUp = { ...unpinned, keyId: "TEST-FIXTURE-ONLY-made-up" };
  await refusesWith(anchor({ key: pinned, raw: seal(madeUp, fx.expected) }), CODES.unknownKeyId, "made-up keyId");
});

test("S23-T11 restore-rejects-revoked-key", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("revoked");
  await refusesWith(anchor({ key, pinned: [pin(key, { revoked: true })] }), CODES.keyRevoked, "revoked");
});

test("S23-T12 restore-rejects-superseded-summary", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("superseded");
  const digest = digestOf(key.keyId, canonicalJson(fx.expected));
  // The summary itself is listed as superseded.
  await refusesWith(anchor({ key, superseded: [{ summaryDigest: digest, height: fx.expected.height, tipHash: fx.expected.tipHash }] }), CODES.superseded, "summary superseded");
  // Its tip is listed as superseded under another summary (e.g. a rolled-back branch).
  await refusesWith(anchor({ key, superseded: [{ summaryDigest: "00".repeat(32), height: fx.expected.height, tipHash: fx.expected.tipHash }] }), CODES.superseded, "tip superseded");
});

test("S23-T13 restore-rejects-lower-height-replay", { timeout: 300_000 }, async () => {
  // M1: the replay check uses the high-water record (highest non-superseded
  // seal), not the superseded list. A valid, not-superseded seal below it is a
  // replay of an older seal.
  const key = fixtureSummaryKey("replay");
  await refusesWith(anchor({ key, highWater: { height: fx.expected.height + 50, summaryDigest: "11".repeat(32) } }), CODES.replayLowerHeight, "lower-height replay");
});

test("S23-T14 restore-rejects-seal-signed-by-validator-key", { timeout: 300_000 }, async () => {
  const genesis = fx.bundle.genesis;
  const keys = fx.bundle.keys;
  const validatorAddress: string = genesis.validators[0].address;
  assert.match(validatorAddress, /^[A-Za-z0-9._-]{1,64}$/, "fixture: a validator address is a schema-valid keyId");
  // A key from the snapshot's own validator set signs the seal and the seal
  // names that validator as its keyId (the signature is 64 bytes, so it passes
  // the schema and must be refused for what it is).
  const summaryText = canonicalJson(fx.expected);
  const signature = signCanonicalDomain(SEAL_DOMAIN, { keyId: validatorAddress, summary: fx.expected }, keys.v1);
  const pinnedFixture = fixtureSummaryKey("pinned");
  await refusesWith(anchor({ key: pinnedFixture, raw: rawSeal(validatorAddress, signature, summaryText) }), CODES.validatorKey, "validator-signed seal");
  // L2: a pinned key equal to a validator, oracle or faucet key (its secp256k1
  // x-coordinate as 32 bytes), checked against the sets the summary binds. The
  // presented seal itself is honest.
  const xOf = (publicKey: string) => publicKey.slice(0, 64);
  const roles: Record<string, string> = {
    validator: genesis.validators[0].publicKey,
    oracle: genesis.activityOracles[0],
    faucet: publicKeyFromPrivate(keys.faucet)
  };
  for (const [role, publicKey] of Object.entries(roles)) {
    assert.match(xOf(publicKey), /^[0-9a-f]{64}$/);
    const honest = fixtureSummaryKey(`honest-${role}`);
    const misPinned = { keyId: `TEST-FIXTURE-ONLY-mispinned-${role}`, publicKey: xOf(publicKey), revoked: false };
    await refusesWith(anchor({ key: honest, pinned: [pin(honest), misPinned] }), CODES.validatorKey, `pinned ${role} key`);
  }
});

test("S23-T15 expected summary comes from a live quorum tip match, never from the snapshot", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("quorum");
  // A correctly sealed summary that matches the snapshot exactly, but the live
  // quorum reports another tip at that height (the snapshot's branch was rolled back).
  await refusesWith(anchor({ key, quorumTip: async (height: number) => ({ height, tipHash: "34".repeat(32) }) }), CODES.quorumTipMismatch, "quorum tip hash");
  // L5: the quorum answers for a different height than it was asked.
  await refusesWith(anchor({ key, quorumTip: async (height: number) => ({ height: height + 1, tipHash: fx.expected.tipHash }) }), CODES.quorumTipMismatch, "quorum tip height");
  // A seal shipped inside the bundle is never used.
  const carrying = bundle();
  carrying.restoreSeal = seal(key, fx.expected);
  await refusesWith(anchor({ key, raw: null }), CODES.sealMissing, "bundle seal only", carrying);
  // L4a: an honest external seal wins over a different (validly signed) bundle seal.
  const other = bundle();
  other.restoreSeal = seal(key, { ...fx.expected, sealedAtMs: fx.expected.sealedAtMs + 1 });
  await succeedsWith(anchor({ key }), key, canonicalJson(fx.expected), "external seal with a different bundle seal", other);
  // L4b: an invalid external seal is refused even with a valid bundle seal.
  const valid = bundle();
  valid.restoreSeal = seal(key, fx.expected);
  const broken = JSON.parse(seal(key, fx.expected));
  const brokenRaw = rawSeal(key.keyId, (broken.signature[0] === "0" ? "1" : "0") + broken.signature.slice(1), canonicalJson(broken.summary));
  await refusesWith(anchor({ key, raw: brokenRaw }), CODES.invalidSignature, "invalid external seal, valid bundle seal", valid);
  // L4c: pinnedKeys / restoreAnchor injected into the bundle are ignored.
  const attacker = fixtureSummaryKey("attacker");
  const injected = bundle();
  injected.pinnedKeys = [pin(attacker)];
  injected.restoreAnchor = { pinnedKeys: [pin(attacker)] };
  injected.network = { ...injected.network, pinnedKeys: [pin(attacker)] };
  await refusesWith(anchor({ key, raw: seal(attacker, fx.expected) }), CODES.unknownKeyId, "injected pinned keys", injected);
});

// ---- Security HOLD on #1204 (M1-M4, L3, L5, vector) ---------------------------

test("S23-T16 superseded higher entry does not block a valid lower seal (high-water is separate)", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("highwater");
  const calls = { readSeal: 0, readSuperseded: 0, readHighWater: 0, readQuorumTip: 0 };
  const restoreAnchor = anchor({ key, calls, superseded: [{ summaryDigest: "77".repeat(32), height: fx.expected.height + 50, tipHash: "88".repeat(32) }] });
  await succeedsWith(restoreAnchor, key, canonicalJson(fx.expected), "superseded higher entry");
  assert.ok(calls.readHighWater >= 1, "the high-water record was never read");
});

test("S23-T17 restore-rejects-high-water-conflict", { timeout: 300_000 }, async () => {
  const key = fixtureSummaryKey("hw-conflict");
  // Same height as the high-water mark, different seal.
  await refusesWith(anchor({ key, highWater: { height: fx.expected.height, summaryDigest: "99".repeat(32) } }), CODES.highWaterConflict, "same height, other digest");
  // A seal above the recorded high-water mark was never published.
  await refusesWith(anchor({ key, highWater: { height: fx.expected.height - 1, summaryDigest: "99".repeat(32) } }), CODES.highWaterConflict, "above high-water");
});

test("S23-T18 keyId is bound into the signature (one key)", { timeout: 300_000 }, async () => {
  // M2: one key A, signed as 'TEST-FIXTURE-ONLY-other', presented as A.
  const key = fixtureSummaryKey("binding");
  await refusesWith(anchor({ key, raw: seal(key, fx.expected, { signAs: "TEST-FIXTURE-ONLY-other" }) }), CODES.invalidSignature, "keyId binding");
});

test("S23-T19 restore-rejects-invalid-anchor-config", { timeout: 300_000 }, async () => {
  // M2 + L3: refused before any write, whatever the seal says.
  const a = fixtureSummaryKey("cfg-a");
  const b = fixtureSummaryKey("cfg-b");
  const configs: Record<string, Json[]> = {
    "duplicate keyId": [pin(a), { ...pin(b), keyId: a.keyId }],
    "duplicate publicKey": [pin(a), { ...pin(b), publicKey: a.publicKey }],
    "revoked as string": [pin(a, { revoked: "false" })],
    "revoked as number": [pin(a, { revoked: 0 })],
    "revoked missing": [{ keyId: a.keyId, publicKey: a.publicKey }],
    "uppercase publicKey": [pin(a, { publicKey: a.publicKey.toUpperCase() })],
    "31-byte publicKey": [pin(a, { publicKey: a.publicKey.slice(2) })],
    "bad keyId": [pin(a, { keyId: "TEST FIXTURE ONLY" })],
    "extra field": [pin(a, { note: "x" })],
    "supersededAtHeight not an integer": [pin(a, { supersededAtHeight: 1.5 })],
    "empty list": []
  };
  for (const [label, pinned] of Object.entries(configs)) await refusesWith(anchor({ key: a, pinned }), CODES.anchorConfigInvalid, label);
});

test("S23-T20 superseded (rotated) key only covers summaries below its supersededAtHeight", { timeout: 300_000 }, async () => {
  // L3: a superseded key was rotated out at supersededAtHeight; unlike a
  // revoked key, its earlier seals stay valid.
  const key = fixtureSummaryKey("rotated");
  await refusesWith(anchor({ key, pinned: [pin(key, { supersededAtHeight: fx.expected.height })] }), CODES.keySuperseded, "at supersededAtHeight");
  await refusesWith(anchor({ key, pinned: [pin(key, { supersededAtHeight: 1 })] }), CODES.keySuperseded, "above supersededAtHeight");
  await succeedsWith(anchor({ key, pinned: [pin(key, { supersededAtHeight: fx.expected.height + 1 })] }), key, canonicalJson(fx.expected), "below supersededAtHeight");
});

test("S23-T21 restore-rejects-wrong-signature-encoding", { timeout: 300_000 }, async () => {
  // M3: the pinned key signs, but not the defined message, or the signature
  // is not 64 bytes of lowercase hex.
  const key = fixtureSummaryKey("encoding");
  const messages: Record<string, MessageOptions> = {
    "no domain": { domain: null },
    "v2 domain": { domain: SEAL_DOMAIN.replace(/v1$/, "v2") },
    "no 0x00 separator": { separator: false },
    "summary without keyId": { withKeyId: false }
  };
  for (const [label, message] of Object.entries(messages)) await refusesWith(anchor({ key, raw: seal(key, fx.expected, { message }) }), CODES.invalidSignature, label);
  const honest = JSON.parse(seal(key, fx.expected));
  const text = canonicalJson(honest.summary);
  const signatures: Record<string, string> = {
    "uppercase hex": honest.signature.toUpperCase(),
    "63-byte signature": honest.signature.slice(0, 126),
    "65-byte signature": `${honest.signature}00`,
    "base64 signature": Buffer.from(honest.signature, "hex").toString("base64")
  };
  for (const [label, signature] of Object.entries(signatures)) await refusesWith(anchor({ key, raw: rawSeal(key.keyId, signature, text) }), CODES.invalidSignature, label);
});

test("S23-T22 restore-rejects-seal-schema-violations", { timeout: 300_000 }, async () => {
  // M4: honestly signed seals over summaries that break the strict schema.
  const key = fixtureSummaryKey("schema");
  const base = canonicalJson(fx.expected);
  const replaceField = (text: string, field: string, value: string) => {
    const pattern = new RegExp(`"${field}":("[^"]*"|-?[0-9.eE+]+)`);
    assert.match(text, pattern, `fixture has ${field}`);
    return text.replace(pattern, `"${field}":${value}`);
  };
  const objectTexts: Record<string, Json> = {
    "extra summary field": { ...fx.expected, extra: "x" },
    "missing summary field": (() => { const s = { ...fx.expected }; delete s.burnedAtoms; return s; })(),
    "height as string": { ...fx.expected, height: String(fx.expected.height) },
    "negative height": { ...fx.expected, height: -1 },
    "other format": { ...fx.expected, format: "zyron-open-testnet-restore-summary-v2" },
    "uppercase tipHash": { ...fx.expected, tipHash: fx.expected.tipHash.toUpperCase() },
    "31-byte stateRoot": { ...fx.expected, stateRoot: fx.expected.stateRoot.slice(2) },
    "non-hex genesisHash": { ...fx.expected, genesisHash: `zz${fx.expected.genesisHash.slice(2)}` },
    "atoms with leading zero": { ...fx.expected, burnedAtoms: "00" },
    "negative atoms": { ...fx.expected, burnedAtoms: "-1" },
    "atoms as number": { ...fx.expected, totalSupplyAtoms: Number(fx.expected.totalSupplyAtoms) },
    "atoms in exponent form": { ...fx.expected, totalSupplyAtoms: "5e15" },
    "provenance extra field": { ...fx.expected, provenance: { ...fx.expected.provenance, extra: "x" } },
    "short commit": { ...fx.expected, provenance: { ...fx.expected.provenance, commit: "0".repeat(39) } },
    "non-ASCII publisher": { ...fx.expected, provenance: { ...fx.expected.provenance, publisher: "TEST-FIXTURE-ONLY-\u00e9" } }
  };
  for (const [label, summary] of Object.entries(objectTexts)) await refusesWith(anchor({ key, raw: seal(key, summary) }), CODES.sealSchemaInvalid, label);
  // Values canonicalJson cannot produce: signed over the exact raw text.
  const rawTexts: Record<string, string> = {
    "float height": replaceField(base, "height", `${fx.expected.height}.5`),
    "unsafe integer height": replaceField(base, "height", "9007199254740993"),
    "infinite height (1e400)": replaceField(base, "height", "1e400"),
    "float sealedAtMs": replaceField(base, "sealedAtMs", "1.5")
  };
  for (const [label, text] of Object.entries(rawTexts)) await refusesWith(anchor({ key, raw: seal(key, text) }), CODES.sealSchemaInvalid, label);
  // A seal whose keyId breaks the keyId pattern (signed honestly under it).
  const badKeyId = { ...key, keyId: "TEST FIXTURE ONLY" };
  await refusesWith(anchor({ key, raw: seal(badKeyId, fx.expected) }), CODES.sealSchemaInvalid, "keyId pattern");
  // Extra top-level field.
  const honest = seal(key, fx.expected);
  await refusesWith(anchor({ key, raw: `${honest.slice(0, -1)},"zz":1}` }), CODES.sealSchemaInvalid, "extra top-level field");
});

test("S23-T23 restore-rejects-non-canonical-seal-text", { timeout: 300_000 }, async () => {
  // M4: canonicalJson(JSON.parse(raw)) must equal raw. Each text is signed
  // honestly over its own summary text.
  const key = fixtureSummaryKey("canonical");
  const base = canonicalJson(fx.expected);
  const duplicateHeight = base.replace(`"height":${fx.expected.height}`, `"height":${fx.expected.height + 7},"height":${fx.expected.height}`);
  assert.notEqual(duplicateHeight, base);
  assert.equal(canonicalJson(JSON.parse(duplicateHeight)), base, "fixture: the last duplicate wins in JSON.parse");
  await refusesWith(anchor({ key, raw: seal(key, duplicateHeight) }), CODES.sealSchemaInvalid, "duplicate key in summary");
  const honest = seal(key, fx.expected);
  await refusesWith(anchor({ key, raw: honest.replace('{"keyId"', `{"keyId":"TEST-FIXTURE-ONLY-shadow","keyId"`) }), CODES.sealSchemaInvalid, "duplicate top-level keyId");
  await refusesWith(anchor({ key, raw: honest.replace('"summary":', '"summary": ') }), CODES.sealSchemaInvalid, "whitespace");
  await refusesWith(anchor({ key, raw: `${honest}\n` }), CODES.sealSchemaInvalid, "trailing newline");
  const parsed = JSON.parse(honest);
  await refusesWith(anchor({ key, raw: `{"summary":${canonicalJson(parsed.summary)},"keyId":${JSON.stringify(parsed.keyId)},"signature":"${parsed.signature}"}` }), CODES.sealSchemaInvalid, "unsorted keys");
  await refusesWith(anchor({ key, raw: honest.replace('"keyId":', '"\\u006beyId":') }), CODES.sealSchemaInvalid, "escaped key name");
});

test("S23-T24 restore-rejects-malformed-seal", { timeout: 300_000 }, async () => {
  // L5: a seal that is not a JSON object text.
  const key = fixtureSummaryKey("malformed");
  const honest = seal(key, fx.expected);
  const cases: Record<string, Json> = {
    "not JSON": "not a seal",
    "truncated JSON": honest.slice(0, -1),
    "NaN literal (JSON has no NaN)": honest.replace(`"height":${fx.expected.height}`, '"height":NaN'),
    "object instead of text": JSON.parse(honest),
    "bytes instead of text": Buffer.from(honest),
    "JSON array": `[${honest}]`,
    "JSON string": JSON.stringify(honest)
  };
  for (const [label, raw] of Object.entries(cases)) await refusesWith(anchor({ key, raw }), CODES.sealMalformed, label);
});

test("S23-T25 anchor and quorum reads that hang time out closed", { timeout: 300_000 }, async () => {
  // L5: each read is bounded by restoreAnchor.timeoutMs.
  const started = Date.now();
  await refusesWith({ ...anchor(), readSeal: hang }, CODES.anchorTimeout, "readSeal hangs");
  await refusesWith({ ...anchor(), readSuperseded: hang }, CODES.anchorTimeout, "readSuperseded hangs");
  await refusesWith({ ...anchor(), readHighWater: hang }, CODES.anchorTimeout, "readHighWater hangs");
  await refusesWith(anchor({ quorumTip: hang }), CODES.quorumTipTimeout, "readQuorumTip hangs");
  assert.ok(Date.now() - started < 60_000, "hanging reads were not bounded by timeoutMs");
});

test("S23-T26 RFC 8032 TEST 1 seal vector (encoding is pinned)", { timeout: 60_000 }, async () => {
  // RFC 8032 section 7.1 TEST 1 secret key: a PUBLIC test vector, never a
  // real or pinned key. Expected values from Security's vector.out (Nov 9).
  const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const keyId = "TEST-FIXTURE-ONLY-rfc8032-test1";
  const publicKey = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
  const summary = {
    format: SUMMARY_FORMAT, chainId: "zyron-s23-anchor-testnet-1", genesisHash: "11".repeat(32), height: 120, tipHash: "22".repeat(32),
    stateRoot: "33".repeat(32), totalSupplyAtoms: "5000000000000000", burnedAtoms: "0", validatorSetHash: "44".repeat(32), oracleSetHash: "55".repeat(32),
    provenance: { publisher: "TEST-FIXTURE-ONLY", workflow: "vector", commit: "0".repeat(40) }, sealedAtMs: 1762700000000
  };
  const expectedJson = '{"keyId":"TEST-FIXTURE-ONLY-rfc8032-test1","summary":{"burnedAtoms":"0","chainId":"zyron-s23-anchor-testnet-1","format":"zyron-open-testnet-restore-summary-v1","genesisHash":"1111111111111111111111111111111111111111111111111111111111111111","height":120,"oracleSetHash":"5555555555555555555555555555555555555555555555555555555555555555","provenance":{"commit":"0000000000000000000000000000000000000000","publisher":"TEST-FIXTURE-ONLY","workflow":"vector"},"sealedAtMs":1762700000000,"stateRoot":"3333333333333333333333333333333333333333333333333333333333333333","tipHash":"2222222222222222222222222222222222222222222222222222222222222222","totalSupplyAtoms":"5000000000000000","validatorSetHash":"4444444444444444444444444444444444444444444444444444444444444444"}}';
  const expectedDigest = "8502e088482170112a1bed522ca8dddb760759e4a822f324fc6d62eadb9b2410";
  const expectedSignature = "b43c879ed07ea7df10447e9de6853e5f64abcebd14297ca23db0960c71925507cf99884da39d2212e6519d3a62ae609d571a25374376ecd8b212ce1db7fe2e0c";
  // The test's own encoding reproduces the vector.
  assert.equal(canonicalJson({ keyId, summary }), expectedJson);
  assert.equal(digestOf(keyId, canonicalJson(summary)), expectedDigest);
  assert.equal(edSign(null, sealMessage(keyId, canonicalJson(summary)), privateKey).toString("hex"), expectedSignature);
  // The implementation's verifier accepts exactly this seal and reports its digest.
  const raw = rawSeal(keyId, expectedSignature, canonicalJson(summary));
  const pinnedKeys = [{ keyId, publicKey, revoked: false }];
  assert.equal(typeof api.verifyRestoreSeal, "function", "verifyRestoreSeal is not exported");
  const verified = await api.verifyRestoreSeal(raw, { pinnedKeys });
  assert.deepEqual(verified, { keyId, summary, summaryDigest: expectedDigest });
  const flipped = rawSeal(keyId, `${expectedSignature.slice(0, -1)}d`, canonicalJson(summary));
  await assert.rejects(async () => api.verifyRestoreSeal(flipped, { pinnedKeys }), (error: Json) => error?.code === CODES.invalidSignature);
});
