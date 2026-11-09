// S2-3 trust anchor T1: an externally sealed restore summary for open-testnet
// backups. Spec: docs/specs/s2-3-t1-sealed-summary.md.
//
// A summary of the live chain (tip, state root, supply, burn, validator and
// oracle set hashes) is built from a live quorum tip match, signed with a
// dedicated testnet-only Ed25519 key, and checked by every restore before the
// network directory is marked complete. Every refusal is fail-closed and has
// its own code. This module verifies and encodes; it never holds, derives or
// prints a private key (the signer CLI reads one from a file path).
import { createHash, createPublicKey, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { canonicalJson } from "./codec.js";

/** Fixed domain tag of the signed message (versioned). */
export const RESTORE_SEAL_DOMAIN = "zyronchain/open-testnet/restore-summary/v1";
/** `format` of a v1 summary (the versioned canonical encoding). */
export const RESTORE_SUMMARY_FORMAT = "zyron-open-testnet-restore-summary-v1";
export const RESTORE_VALIDATOR_SET_DOMAIN = "zyronchain/open-testnet/validator-set/v1";
export const RESTORE_ORACLE_SET_DOMAIN = "zyronchain/open-testnet/oracle-set/v1";
export const RESTORE_KEY_ID_DOMAIN = "zyronchain/open-testnet/restore-summary-key-id/v1";
export const RESTORE_KEYS_FORMAT = "zyronchain-restore-summary-keys-v1";
export const RESTORE_RECORD_FORMAT = "zyronchain-restore-summary-record-v1";
export const RESTORE_KEY_PURPOSE = "open-testnet-restore-summary";

/** Every refusal code. Each one is distinct; none is ever a local I/O error. */
export const RESTORE_ANCHOR_CODES = Object.freeze({
  anchorMissing: "RESTORE_ANCHOR_MISSING",
  sealMissing: "RESTORE_SEAL_MISSING",
  anchorUnavailable: "RESTORE_ANCHOR_UNAVAILABLE",
  recordInvalid: "RESTORE_ANCHOR_RECORD_INVALID",
  quorumTipUnavailable: "RESTORE_QUORUM_TIP_UNAVAILABLE",
  quorumTipMismatch: "RESTORE_QUORUM_TIP_MISMATCH",
  invalidSignature: "RESTORE_SEAL_INVALID_SIGNATURE",
  unknownKeyId: "RESTORE_SEAL_UNKNOWN_KEY_ID",
  keyRevoked: "RESTORE_SEAL_KEY_REVOKED",
  validatorKey: "RESTORE_SEAL_VALIDATOR_KEY",
  malformed: "RESTORE_SUMMARY_MALFORMED",
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
} as const);
export type RestoreAnchorCode = typeof RESTORE_ANCHOR_CODES[keyof typeof RESTORE_ANCHOR_CODES];
const C = RESTORE_ANCHOR_CODES;

/**
 * A refusal. It never carries a `cause` or a `syscall`, so the restore retry
 * (isLocalIoError) can never mistake it for a local disk failure.
 */
export class RestoreAnchorError extends Error {
  readonly code: RestoreAnchorCode;
  constructor(code: RestoreAnchorCode, detail = "") {
    super(`restore refused [${code}]${detail ? `: ${detail}` : ""}`);
    this.name = "RestoreAnchorError";
    this.code = code;
  }
}
export function isRestoreAnchorError(error: unknown): error is RestoreAnchorError {
  return error instanceof RestoreAnchorError || (typeof (error as { code?: unknown })?.code === "string" && Object.values(C).includes((error as { code: RestoreAnchorCode }).code));
}
const refuse = (code: RestoreAnchorCode, detail = ""): never => { throw new RestoreAnchorError(code, detail); };

export interface RestoreSummaryProvenance { publisher: string; workflow: string; commit: string }
export interface RestoreSummary {
  format: typeof RESTORE_SUMMARY_FORMAT;
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
  stateRoot: string;
  totalSupplyAtoms: string;
  burnedAtoms: string;
  validatorSetHash: string;
  oracleSetHash: string;
  provenance: RestoreSummaryProvenance;
  sealedAtMs: number;
}
export interface RestoreSeal { summary: RestoreSummary; keyId: string; signature: string }
export interface PinnedRestoreKey { keyId: string; publicKey: string; revoked?: boolean }
export interface SupersededEntry { summaryDigest: string; height: number; tipHash: string }
export interface QuorumTip { height: number; tipHash: string }
export interface RestoreAnchor {
  pinnedKeys: PinnedRestoreKey[];
  readSeal: () => Promise<RestoreSeal | null | undefined>;
  readSuperseded: () => Promise<SupersededEntry[]>;
  readQuorumTip: (height: number) => Promise<QuorumTip>;
}

export const RESTORE_SUMMARY_FIELDS = ["format", "chainId", "genesisHash", "height", "tipHash", "stateRoot", "totalSupplyAtoms", "burnedAtoms", "validatorSetHash", "oracleSetHash", "provenance", "sealedAtMs"] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const ATOMS = /^(0|[1-9][0-9]{0,24})$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ZERO_HASH = "0".repeat(64);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const safeInt = (value: unknown, min: number): value is number => Number.isSafeInteger(value) && (value as number) >= min;
const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");

export function isTestnetChainId(chainId: unknown): chainId is string {
  return typeof chainId === "string" && /^[a-z0-9-]{3,64}$/.test(chainId) && chainId.includes("testnet") && !chainId.includes("mainnet");
}

/**
 * The signed bytes: domain tag || 0x00 || canonicalJson({ keyId, summary }).
 * canonicalJson sorts object keys and allows only safe integers, so every
 * summary field and the keyId are covered with one encoding.
 */
export function restoreSealMessage(keyId: string, summary: unknown): Buffer {
  return Buffer.concat([Buffer.from(RESTORE_SEAL_DOMAIN, "utf8"), Buffer.from([0]), Buffer.from(canonicalJson({ keyId, summary }), "utf8")]);
}
export function restoreSummaryDigest(keyId: string, summary: unknown): string {
  return sha256Hex(restoreSealMessage(keyId, summary));
}
/** Hash of an ordered key list (order and membership both count). */
export function restoreSetHash(domain: string, publicKeys: readonly string[]): string {
  return sha256Hex(Buffer.concat([Buffer.from(domain, "utf8"), Buffer.from([0]), Buffer.from(canonicalJson([...publicKeys]), "utf8")]));
}
export function restoreValidatorSetHash(validators: ReadonlyArray<{ publicKey: string }>): string {
  return restoreSetHash(RESTORE_VALIDATOR_SET_DOMAIN, validators.map((validator) => validator.publicKey));
}
export function restoreOracleSetHash(oracles: readonly string[]): string {
  return restoreSetHash(RESTORE_ORACLE_SET_DOMAIN, oracles);
}

/** keyId of a pinned production key: derived from the raw 32-byte Ed25519 public key. */
export function restoreKeyId(rawPublicKeyHex: string): string {
  return `t1-${createHash("sha256").update(`${RESTORE_KEY_ID_DOMAIN}\n`).update(Buffer.from(rawPublicKeyHex, "hex")).digest("hex").slice(0, 32)}`;
}
export function ed25519PublicKeyObject(rawHex: string): KeyObject {
  if (typeof rawHex !== "string" || !HEX64.test(rawHex)) throw new Error("an Ed25519 public key is 32 bytes of lowercase hex");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawHex, "hex")]), format: "der", type: "spki" });
}
export function ed25519RawPublicKeyHex(key: KeyObject): string {
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  const der = (key.type === "private" ? createPublicKey(key) : key).export({ format: "der", type: "spki" });
  return Buffer.from(der.subarray(der.length - 32)).toString("hex");
}

/** Signs a summary (signer CLI only). Returns the 128-hex Ed25519 signature. */
export function signRestoreSummary(keyId: string, summary: RestoreSummary, privateKey: KeyObject): string {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") throw new Error("the restore summary key must be an Ed25519 private key");
  parseRestoreSummary(summary);
  return cryptoSign(null, restoreSealMessage(keyId, summary), privateKey).toString("hex");
}

/** Strict schema of a v1 summary (checked after the signature). */
export function parseRestoreSummary(value: unknown): RestoreSummary {
  if (!isPlainObject(value) || !exactKeys(value, RESTORE_SUMMARY_FIELDS) || value.format !== RESTORE_SUMMARY_FORMAT) return refuse(C.malformed, "summary fields are not exactly the v1 field set");
  if (!isTestnetChainId(value.chainId)) return refuse(C.malformed, "chainId is not an open-testnet chain ID");
  for (const field of ["genesisHash", "tipHash", "stateRoot", "validatorSetHash", "oracleSetHash"] as const) {
    if (typeof value[field] !== "string" || !HEX64.test(value[field] as string)) return refuse(C.malformed, `${field} must be 64 lowercase hex characters`);
  }
  for (const field of ["totalSupplyAtoms", "burnedAtoms"] as const) {
    if (typeof value[field] !== "string" || !ATOMS.test(value[field] as string)) return refuse(C.malformed, `${field} must be a decimal string`);
  }
  if (!safeInt(value.height, 1)) return refuse(C.malformed, "height must be a positive integer");
  if (!safeInt(value.sealedAtMs, 0)) return refuse(C.malformed, "sealedAtMs must be a non-negative integer");
  const provenance = value.provenance;
  if (!isPlainObject(provenance) || !exactKeys(provenance, ["publisher", "workflow", "commit"]) ||
    typeof provenance.publisher !== "string" || !/^[ -~]{1,128}$/.test(provenance.publisher) ||
    typeof provenance.workflow !== "string" || !/^[ -~]{1,256}$/.test(provenance.workflow) ||
    typeof provenance.commit !== "string" || !/^[0-9a-f]{40}$/.test(provenance.commit)) {
    return refuse(C.malformed, "provenance must name the publisher, the workflow and the 40-hex source commit");
  }
  if (BigInt(value.burnedAtoms as string) > BigInt(value.totalSupplyAtoms as string)) return refuse(C.malformed, "burnedAtoms exceeds totalSupplyAtoms");
  return structuredClone(value) as unknown as RestoreSummary;
}

function signedByChainKey(seal: RestoreSeal, chainPublicKeys: ReadonlySet<string>): boolean {
  if (typeof seal.signature !== "string" || !HEX128.test(seal.signature)) return false;
  const signature = Buffer.from(seal.signature, "hex");
  let forms: Buffer[];
  try {
    forms = [restoreSealMessage(seal.keyId, seal.summary), Buffer.from(canonicalJson({ domain: RESTORE_SEAL_DOMAIN, payload: { keyId: seal.keyId, summary: seal.summary } }), "utf8")];
  } catch { return false; }
  for (const publicKey of chainPublicKeys) {
    if (!/^[0-9a-f]{128}$/.test(publicKey)) continue;
    const point = Buffer.from(`04${publicKey}`, "hex");
    for (const form of forms) {
      try { if (secp256k1.verify(signature, form, point, { format: "compact" })) return true; } catch { /* not a signature under this key */ }
    }
  }
  return false;
}

export interface RestoreBundleView {
  chainId: string;
  genesisHash: string;
  /** Height and hash of the bundle's last block (checked again after the replay). */
  height: number;
  tipHash: string;
  validatorSetHash: string;
  oracleSetHash: string;
  /** Every chain key of the network (validators, oracles, faucet and roles; secp256k1 hex). */
  chainPublicKeys: ReadonlySet<string>;
}

async function read<T>(reader: () => Promise<T>, code: RestoreAnchorCode, label: string): Promise<T> {
  try { return await reader(); } catch (error) {
    if (isRestoreAnchorError(error)) throw error;
    // The reader's error is summarised, never attached as a cause.
    return refuse(code, `${label} could not be read`);
  }
}

/**
 * Pre-write checks (spec section 6). Order: anchor, seal, chain-key
 * signature, keyId, revocation, signature, schema, superseded, lower height,
 * chain, genesis, sets, height, live quorum tip. Returns the verified seal.
 */
export async function verifyRestoreAnchor(anchor: RestoreAnchor | undefined, view: RestoreBundleView): Promise<{ summary: RestoreSummary; keyId: string; summaryDigest: string }> {
  if (!anchor || typeof anchor !== "object" || typeof anchor.readSeal !== "function" || typeof anchor.readSuperseded !== "function" || typeof anchor.readQuorumTip !== "function") {
    return refuse(C.anchorMissing, "no independent restore anchor is configured");
  }
  const pinned = Array.isArray(anchor.pinnedKeys) ? anchor.pinnedKeys : [];
  if (pinned.length === 0) return refuse(C.anchorMissing, "no restore summary key is pinned");
  const seal = await read(anchor.readSeal, C.anchorUnavailable, "the sealed summary");
  if (seal === null || seal === undefined) return refuse(C.sealMissing, "no sealed summary is published for this restore");
  if (!isPlainObject(seal) || typeof seal.keyId !== "string" || !KEY_ID.test(seal.keyId) || typeof seal.signature !== "string") return refuse(C.malformed, "the seal is not { summary, keyId, signature }");
  if (view.chainPublicKeys.has(seal.keyId) || signedByChainKey(seal, view.chainPublicKeys)) {
    return refuse(C.validatorKey, "the seal names or is signed by a validator, oracle or other chain key");
  }
  const candidates = pinned.filter((key) => key?.keyId === seal.keyId);
  if (candidates.length === 0) return refuse(C.unknownKeyId, `keyId ${seal.keyId} is not pinned`);
  if (candidates.length > 1) return refuse(C.recordInvalid, `keyId ${seal.keyId} is pinned twice`);
  const key = candidates[0]!;
  if (view.chainPublicKeys.has(key.publicKey)) return refuse(C.validatorKey, "a chain key is pinned as the restore summary key");
  if (key.revoked === true) return refuse(C.keyRevoked, `keyId ${seal.keyId} is revoked`);
  let valid = false;
  try { valid = HEX128.test(seal.signature) && cryptoVerify(null, restoreSealMessage(seal.keyId, seal.summary), ed25519PublicKeyObject(key.publicKey), Buffer.from(seal.signature, "hex")); } catch { valid = false; }
  if (!valid) return refuse(C.invalidSignature, "the Ed25519 signature does not cover this keyId and these summary fields");
  const summary = parseRestoreSummary(seal.summary);
  const summaryDigest = restoreSummaryDigest(seal.keyId, summary);
  const superseded = await read(anchor.readSuperseded, C.anchorUnavailable, "the superseded record");
  if (!Array.isArray(superseded)) return refuse(C.recordInvalid, "the superseded record is not a list");
  for (const entry of superseded) {
    if (!isPlainObject(entry) || typeof entry.summaryDigest !== "string" || typeof entry.tipHash !== "string" || !safeInt(entry.height, 1)) return refuse(C.recordInvalid, "a superseded entry is malformed");
  }
  if (superseded.some((entry) => entry.summaryDigest === summaryDigest || (entry.height === summary.height && entry.tipHash === summary.tipHash) || entry.tipHash === summary.tipHash)) {
    return refuse(C.superseded, `the summary or its tip at height ${summary.height} is superseded`);
  }
  const highest = superseded.reduce((max, entry) => Math.max(max, entry.height), 0);
  if (highest > summary.height) return refuse(C.replayLowerHeight, `summary height ${summary.height} is below height ${highest} already in the superseded record`);
  if (summary.chainId !== view.chainId) return refuse(C.wrongChain, `summary is for ${summary.chainId}, the snapshot for ${view.chainId}`);
  if (summary.genesisHash !== view.genesisHash) return refuse(C.genesisMismatch, "summary genesis hash differs from the snapshot genesis");
  if (summary.validatorSetHash !== view.validatorSetHash) return refuse(C.validatorSetMismatch, "validator set differs from the summary");
  if (summary.oracleSetHash !== view.oracleSetHash) return refuse(C.oracleSetMismatch, "oracle set differs from the summary");
  if (summary.height < view.height) return refuse(C.stale, `summary height ${summary.height} is below the snapshot tip ${view.height}`);
  if (summary.height > view.height) return refuse(C.aboveTip, `summary height ${summary.height} is above the snapshot tip ${view.height}`);
  const quorum = await read(() => anchor.readQuorumTip(summary.height), C.quorumTipUnavailable, "the live quorum tip");
  if (!isPlainObject(quorum) || quorum.height !== summary.height || quorum.tipHash !== summary.tipHash) {
    return refuse(C.quorumTipMismatch, `the live quorum does not report the sealed tip at height ${summary.height}`);
  }
  if (view.tipHash !== summary.tipHash) return refuse(C.tipMismatch, "the snapshot tip differs from the sealed tip");
  return { summary, keyId: seal.keyId, summaryDigest };
}

/** The read-only chain view the state fields are computed from. */
export interface RestoreChainView {
  height: number;
  tip: { hash: string; header: { stateRoot: string } };
  genesisSupplyAtoms(): number;
  getState(): { snapshot(): { accounts: Array<{ balanceAtoms: number }> } };
}
export interface RestoreStateFields { height: number; tipHash: string; stateRoot: string; totalSupplyAtoms: string; burnedAtoms: string }

/** State fields of a chain at its tip. burned = total - balances - pending (pending is 0). */
export function restoreStateFieldsOf(chain: RestoreChainView): RestoreStateFields {
  const total = BigInt(chain.genesisSupplyAtoms());
  let balances = 0n;
  for (const account of chain.getState().snapshot().accounts) balances += BigInt(account.balanceAtoms);
  return { height: chain.height, tipHash: chain.tip.hash, stateRoot: chain.tip.header.stateRoot, totalSupplyAtoms: total.toString(), burnedAtoms: (total - balances).toString() };
}

/** Post-replay checks, before the completion marker. */
export function assertReplayMatchesSummary(summary: RestoreSummary, replayed: RestoreStateFields): void {
  if (replayed.height !== summary.height || replayed.tipHash !== summary.tipHash) refuse(C.tipMismatch, "the replayed tip differs from the sealed tip");
  if (replayed.stateRoot !== summary.stateRoot) refuse(C.stateMismatch, "the replayed state root differs from the sealed state root");
  if (replayed.totalSupplyAtoms !== summary.totalSupplyAtoms) refuse(C.supplyMismatch, "the replayed total supply differs from the sealed total supply");
  if (replayed.burnedAtoms !== summary.burnedAtoms) refuse(C.burnMismatch, "the replayed burned atoms differ from the sealed burned atoms");
}

/**
 * Live quorum tip match: at least floor(2n/3)+1 of n distinct live sources
 * must report the same tip hash at `height`.
 */
export function quorumTipFromReports(height: number, reports: ReadonlyArray<{ source: string; height?: number; tipHash?: string } | undefined>, total = reports.length): QuorumTip {
  if (!safeInt(height, 1) || total < 1) return refuse(C.quorumTipUnavailable, "no live quorum");
  const need = Math.floor((2 * total) / 3) + 1;
  const sources = new Set<string>();
  const counts = new Map<string, number>();
  for (const report of reports) {
    if (!report || report.height !== height || typeof report.tipHash !== "string" || !HEX64.test(report.tipHash) || sources.has(report.source)) continue;
    sources.add(report.source);
    counts.set(report.tipHash, (counts.get(report.tipHash) ?? 0) + 1);
  }
  const agreed = [...counts.entries()].filter(([, count]) => count >= need);
  if (agreed.length === 1) return { height, tipHash: agreed[0]![0] };
  if (sources.size < need) return refuse(C.quorumTipUnavailable, `only ${sources.size} of ${total} live sources answered for height ${height} (${need} needed)`);
  return refuse(C.quorumTipMismatch, `the live sources do not agree on the tip at height ${height}`);
}

/**
 * Summary builder (spec section 5). Input: one validator's own live chain at
 * the summary height and the live quorum tip match for that height; never a
 * snapshot. Refuses unless the chain's tip is the quorum's tip.
 */
export function buildRestoreSummary(input: {
  chainId: string; genesisHash: string; chain: RestoreChainView; quorumTip: QuorumTip;
  validators: ReadonlyArray<{ publicKey: string }>; activityOracles: readonly string[];
  provenance: RestoreSummaryProvenance; sealedAtMs: number;
}): RestoreSummary {
  const fields = restoreStateFieldsOf(input.chain);
  if (input.quorumTip.height !== fields.height || input.quorumTip.tipHash !== fields.tipHash) {
    throw new Error("summary not built: this validator's tip is not the live quorum tip at that height");
  }
  return parseRestoreSummary({
    format: RESTORE_SUMMARY_FORMAT, chainId: input.chainId, genesisHash: input.genesisHash, ...fields,
    validatorSetHash: restoreValidatorSetHash(input.validators), oracleSetHash: restoreOracleSetHash(input.activityOracles),
    provenance: { ...input.provenance }, sealedAtMs: input.sealedAtMs
  });
}

// ---- pinned keys and the append-only record (repository files) -------------

export interface PinnedKeysFile { format: typeof RESTORE_KEYS_FORMAT; networkClass: "testnet"; purpose: typeof RESTORE_KEY_PURPOSE; keys: Array<{ keyId: string; publicKey: string; addedIn: string }> }
export type RecordEntry =
  | { index: number; prev: string; kind: "revoke-key"; keyId: string; reason: string }
  | { index: number; prev: string; kind: "supersede"; summaryDigest: string; height: number; tipHash: string; reason: string };
export interface RecordFile { format: typeof RESTORE_RECORD_FORMAT; entries: RecordEntry[] }

export function parsePinnedKeysFile(value: unknown): PinnedKeysFile {
  if (!isPlainObject(value) || !exactKeys(value, ["format", "networkClass", "purpose", "keys"]) || value.format !== RESTORE_KEYS_FORMAT ||
    value.networkClass !== "testnet" || value.purpose !== RESTORE_KEY_PURPOSE || !Array.isArray(value.keys)) return refuse(C.recordInvalid, "the pinned key file is malformed");
  const ids = new Set<string>();
  const publics = new Set<string>();
  for (const entry of value.keys) {
    if (!isPlainObject(entry) || !exactKeys(entry, ["keyId", "publicKey", "addedIn"]) || typeof entry.keyId !== "string" || typeof entry.publicKey !== "string" || typeof entry.addedIn !== "string") return refuse(C.recordInvalid, "a pinned key entry is malformed");
    try { ed25519PublicKeyObject(entry.publicKey); } catch { return refuse(C.recordInvalid, "a pinned public key is not a raw Ed25519 key"); }
    if (restoreKeyId(entry.publicKey) !== entry.keyId) return refuse(C.recordInvalid, "a pinned keyId does not match its public key");
    if (ids.has(entry.keyId) || publics.has(entry.publicKey)) return refuse(C.recordInvalid, "a pinned key is listed twice");
    ids.add(entry.keyId); publics.add(entry.publicKey);
  }
  return value as unknown as PinnedKeysFile;
}

export function recordEntryHash(entry: RecordEntry): string { return sha256Hex(canonicalJson(entry)); }

export function parseRecordFile(value: unknown): RecordFile {
  if (!isPlainObject(value) || !exactKeys(value, ["format", "entries"]) || value.format !== RESTORE_RECORD_FORMAT || !Array.isArray(value.entries)) return refuse(C.recordInvalid, "the record file is malformed");
  let prev = ZERO_HASH;
  for (const [position, entry] of value.entries.entries()) {
    const bad = (detail: string): never => refuse(C.recordInvalid, `record entry ${position + 1}: ${detail}`);
    if (!isPlainObject(entry)) return bad("not an object");
    if (entry.index !== position + 1) return bad("index is not the next index (an entry was removed or reordered)");
    if (entry.prev !== prev) return bad("prev does not match the previous entry (the record was edited)");
    if (typeof entry.reason !== "string" || entry.reason.length === 0 || entry.reason.length > 500) return bad("reason is missing");
    if (entry.kind === "revoke-key") {
      if (!exactKeys(entry, ["index", "prev", "kind", "keyId", "reason"]) || typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId)) return bad("malformed revoke-key");
    } else if (entry.kind === "supersede") {
      if (!exactKeys(entry, ["index", "prev", "kind", "summaryDigest", "height", "tipHash", "reason"]) || typeof entry.summaryDigest !== "string" || !HEX64.test(entry.summaryDigest) ||
        !safeInt(entry.height, 1) || typeof entry.tipHash !== "string" || !HEX64.test(entry.tipHash)) return bad("malformed supersede");
    } else return bad("unknown kind");
    prev = recordEntryHash(entry as unknown as RecordEntry);
  }
  return value as unknown as RecordFile;
}

/** Returns a new record with one entry appended (index and prev filled in). Never edits existing entries. */
export function appendRecordEntry(record: RecordFile, entry: { kind: "revoke-key"; keyId: string; reason: string } | { kind: "supersede"; summaryDigest: string; height: number; tipHash: string; reason: string }): RecordFile {
  const current = parseRecordFile(record);
  const last = current.entries.at(-1);
  const next = { index: current.entries.length + 1, prev: last ? recordEntryHash(last) : ZERO_HASH, ...entry } as RecordEntry;
  return parseRecordFile({ format: RESTORE_RECORD_FORMAT, entries: [...current.entries, next] });
}

/** Pinned keys with revocations applied, and the superseded list, from the two repository files. */
export function restoreTrustFromFiles(keysFile: unknown, recordFile: unknown): { pinnedKeys: PinnedRestoreKey[]; superseded: SupersededEntry[] } {
  const keys = parsePinnedKeysFile(keysFile);
  const record = parseRecordFile(recordFile);
  const revoked = new Set(record.entries.filter((entry) => entry.kind === "revoke-key").map((entry) => entry.keyId));
  return {
    pinnedKeys: keys.keys.map(({ keyId, publicKey }) => ({ keyId, publicKey, ...(revoked.has(keyId) ? { revoked: true } : {}) })),
    superseded: record.entries.flatMap((entry) => entry.kind === "supersede" ? [{ summaryDigest: entry.summaryDigest, height: entry.height, tipHash: entry.tipHash }] : [])
  };
}
