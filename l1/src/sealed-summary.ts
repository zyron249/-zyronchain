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
import { assertHex, canonicalJson } from "./codec.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";

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

/**
 * Every refusal code (29). Each one is distinct and none is ever a local I/O
 * error, so restoreNetworkWithLocalRetry never retries a refusal.
 */
export const RESTORE_ANCHOR_CODES = Object.freeze({
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
  snapshotCorrupt: "RESTORE_SNAPSHOT_CORRUPT",
  stagingLeftoverLimit: "RESTORE_STAGING_LEFTOVER_LIMIT"
} as const);
export type RestoreAnchorCode = typeof RESTORE_ANCHOR_CODES[keyof typeof RESTORE_ANCHOR_CODES];
const C = RESTORE_ANCHOR_CODES;
const ALL_CODES = new Set<string>(Object.values(C));

/**
 * A refusal. It never carries a `cause` or a `syscall`, so isLocalIoError can
 * never mistake it (or the network error behind it) for a local disk failure.
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
  return error instanceof RestoreAnchorError || (typeof (error as { code?: unknown })?.code === "string" && ALL_CODES.has((error as { code: string }).code));
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
export interface PinnedRestoreKey { keyId: string; publicKey: string; revoked: boolean; supersededAtHeight?: number }
export interface SupersededEntry { summaryDigest: string; height: number; tipHash: string }
/**
 * Effective high-water value. tipHash is optional in the reader contract; when
 * present (the pinned-file reader always sets it) it must equal the sealed
 * summary's tipHash.
 */
export interface HighWater { height: number; summaryDigest: string; tipHash?: string }
export interface QuorumTip { height: number; tipHash: string }
export interface RestoreAnchor {
  pinnedKeys: PinnedRestoreKey[];
  /** The raw seal text: canonicalJson({ keyId, signature, summary }); null when nothing is sealed. */
  readSeal: () => Promise<string | null | undefined>;
  /** Append-only list of superseded summaries / tips. */
  readSuperseded: () => Promise<SupersededEntry[]>;
  /** Highest non-superseded seal (separate append-only record). */
  readHighWater: () => Promise<HighWater | null | undefined>;
  readQuorumTip: (height: number) => Promise<QuorumTip>;
  /** Bound on each read (default 30 s); a hang fails closed. */
  timeoutMs?: number;
}
export const DEFAULT_RESTORE_READ_TIMEOUT_MS = 30_000;

export const RESTORE_SUMMARY_FIELDS = ["format", "chainId", "genesisHash", "height", "tipHash", "stateRoot", "totalSupplyAtoms", "burnedAtoms", "validatorSetHash", "oracleSetHash", "provenance", "sealedAtMs"] as const;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const ATOMS = /^(0|[1-9][0-9]*)$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const CHAIN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PRINTABLE = /^[\x20-\x7e]{1,128}$/;
const ZERO_HASH = "0".repeat(64);
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const exactKeys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const safeInt = (value: unknown, min: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= min && !Object.is(value, -0);
const sha256Hex = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
const isHex32 = (value: unknown): value is string => { if (typeof value !== "string") return false; try { assertHex(value, 32, "hash"); return true; } catch { return false; } };

export function isTestnetChainId(chainId: unknown): chainId is string {
  return typeof chainId === "string" && /^[a-z0-9-]{3,64}$/.test(chainId) && chainId.includes("testnet") && !chainId.includes("mainnet");
}

/**
 * The signed bytes: domain tag || 0x00 || canonicalJson({ keyId, summary }).
 * codec.ts canonicalJson sorts keys by UTF-16 code units and serializes
 * strings and safe integers as ECMAScript JSON.stringify does; for this
 * schema (printable-ASCII strings, safe non-negative integers, plain objects)
 * that is byte-identical to RFC 8785 (JCS).
 */
export function restoreSealMessage(keyId: string, summary: unknown): Buffer {
  return Buffer.concat([Buffer.from(RESTORE_SEAL_DOMAIN, "utf8"), Buffer.from([0]), Buffer.from(canonicalJson({ keyId, summary }), "utf8")]);
}
export function restoreSummaryDigest(keyId: string, summary: unknown): string {
  return sha256Hex(restoreSealMessage(keyId, summary));
}
/** The raw seal text a publisher writes: canonicalJson({ keyId, signature, summary }). */
export function restoreSealText(keyId: string, signature: string, summary: RestoreSummary): string {
  return canonicalJson({ keyId, signature, summary });
}
/** Hash of an ordered key list (order and membership both count): SHA-256(domain || 0x00 || canonicalJson(keys)). */
export function restoreSetHash(domain: string, publicKeys: readonly string[]): string {
  return sha256Hex(Buffer.concat([Buffer.from(domain, "utf8"), Buffer.from([0]), Buffer.from(canonicalJson([...publicKeys]), "utf8")]));
}
export function restoreValidatorSetHash(validators: ReadonlyArray<{ publicKey: string }>): string {
  return restoreSetHash(RESTORE_VALIDATOR_SET_DOMAIN, validators.map((validator) => validator.publicKey));
}
export function restoreOracleSetHash(oracles: readonly string[]): string {
  return restoreSetHash(RESTORE_ORACLE_SET_DOMAIN, oracles);
}

/** keyId of a production key: derived from the raw 32-byte Ed25519 public key. */
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
  if (!KEY_ID.test(keyId)) throw new Error("invalid keyId");
  assertSummarySchema(summary);
  return cryptoSign(null, restoreSealMessage(keyId, summary), privateKey).toString("hex");
}

/** Pinned key list (RESTORE_ANCHOR_CONFIG_INVALID on any deviation). */
export function assertPinnedKeys(value: unknown): asserts value is PinnedRestoreKey[] {
  if (!Array.isArray(value) || value.length === 0) refuse(C.anchorConfigInvalid, "no restore summary key is pinned");
  const ids = new Set<string>();
  const publics = new Set<string>();
  for (const entry of value as unknown[]) {
    if (!isPlainObject(entry) || !exactKeys(entry, ["keyId", "publicKey", "revoked"], ["supersededAtHeight"])) refuse(C.anchorConfigInvalid, "a pinned key entry is not { keyId, publicKey, revoked, supersededAtHeight? }");
    const e = entry as Record<string, unknown>;
    if (typeof e.keyId !== "string" || !KEY_ID.test(e.keyId)) refuse(C.anchorConfigInvalid, "a pinned keyId is invalid");
    if (typeof e.publicKey !== "string" || !HEX64.test(e.publicKey)) refuse(C.anchorConfigInvalid, "a pinned public key is not 32 bytes of lowercase hex");
    if (typeof e.revoked !== "boolean") refuse(C.anchorConfigInvalid, "revoked must be a boolean");
    if (Object.hasOwn(e, "supersededAtHeight") && !safeInt(e.supersededAtHeight, 0)) refuse(C.anchorConfigInvalid, "supersededAtHeight must be a non-negative integer");
    if (ids.has(e.keyId as string) || publics.has(e.publicKey as string)) refuse(C.anchorConfigInvalid, "a pinned key is listed twice");
    ids.add(e.keyId as string); publics.add(e.publicKey as string);
  }
}

/** Strict v1 summary schema (RESTORE_SEAL_SCHEMA_INVALID). */
export function assertSummarySchema(value: unknown): asserts value is RestoreSummary {
  const bad = (detail: string): never => refuse(C.sealSchemaInvalid, detail);
  if (!isPlainObject(value) || !exactKeys(value, RESTORE_SUMMARY_FIELDS)) return bad("summary fields are not exactly the v1 field set");
  if (value.format !== RESTORE_SUMMARY_FORMAT) return bad("unknown summary format");
  if (typeof value.chainId !== "string" || !CHAIN_ID.test(value.chainId)) return bad("chainId is invalid");
  for (const field of ["genesisHash", "tipHash", "stateRoot", "validatorSetHash", "oracleSetHash"] as const) if (!isHex32(value[field])) return bad(`${field} must be 32 bytes of lowercase hex`);
  for (const field of ["totalSupplyAtoms", "burnedAtoms"] as const) if (typeof value[field] !== "string" || !ATOMS.test(value[field] as string)) return bad(`${field} must be a decimal string`);
  if (!safeInt(value.height, 0)) return bad("height must be a safe non-negative integer");
  if (!safeInt(value.sealedAtMs, 0)) return bad("sealedAtMs must be a safe non-negative integer");
  const provenance = value.provenance;
  if (!isPlainObject(provenance) || !exactKeys(provenance, ["commit", "publisher", "workflow"]) || typeof provenance.commit !== "string" || !/^[0-9a-f]{40}$/.test(provenance.commit) ||
    typeof provenance.publisher !== "string" || !PRINTABLE.test(provenance.publisher) || typeof provenance.workflow !== "string" || !PRINTABLE.test(provenance.workflow)) {
    return bad("provenance must be exactly { commit (40 hex), publisher, workflow (printable ASCII) }");
  }
}

/**
 * Parses the raw seal text, in this order: not text, not JSON (NaN, +1, 01,
 * truncated) or not a JSON object -> RESTORE_SEAL_MALFORMED; then
 * canonicalJson(JSON.parse(raw)) === raw (a throw, e.g. on Infinity, is a
 * mismatch) and the strict v1 schema -> RESTORE_SEAL_SCHEMA_INVALID (-0,
 * unsafe integers, whitespace, unsorted or duplicate keys, escapes, non-ASCII).
 */
export function parseRestoreSealText(raw: unknown): { keyId: string; signature: string; summary: RestoreSummary } {
  if (typeof raw !== "string") return refuse(C.sealMalformed, "the seal is not text");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return refuse(C.sealMalformed, "the seal is not JSON"); }
  if (!isPlainObject(value)) return refuse(C.sealMalformed, "the seal is not a JSON object");
  let canonical: string | undefined;
  try { canonical = canonicalJson(value); } catch { canonical = undefined; }
  if (!/^[\x20-\x7e]*$/.test(raw) || canonical !== raw) return refuse(C.sealSchemaInvalid, "the seal text is not its own canonical encoding (printable ASCII, sorted keys, no whitespace, no duplicates, safe integers)");
  if (!exactKeys(value, ["keyId", "signature", "summary"]) || typeof value.keyId !== "string" || !KEY_ID.test(value.keyId) || typeof value.signature !== "string") {
    return refuse(C.sealSchemaInvalid, "the seal is not exactly { keyId, signature, summary }");
  }
  assertSummarySchema(value.summary);
  return { keyId: value.keyId, signature: value.signature, summary: value.summary as RestoreSummary };
}

/** Chain keys (secp256k1 public keys and addresses) that may never anchor a restore. */
export interface ChainKeySet { publicKeys: ReadonlySet<string>; ids: ReadonlySet<string>; xCoordinates: ReadonlySet<string> }

function signedByChainKey(seal: { keyId: string; signature: string; summary: RestoreSummary }, publicKeys: ReadonlySet<string>): boolean {
  if (!HEX128.test(seal.signature)) return false;
  const signature = Buffer.from(seal.signature, "hex");
  const forms = [restoreSealMessage(seal.keyId, seal.summary), Buffer.from(canonicalJson({ domain: RESTORE_SEAL_DOMAIN, payload: { keyId: seal.keyId, summary: seal.summary } }), "utf8")];
  for (const publicKey of publicKeys) {
    if (!HEX128.test(publicKey)) continue;
    const point = Buffer.from(`04${publicKey}`, "hex");
    for (const form of forms) {
      try { if (secp256k1.verify(signature, form, point, { format: "compact" })) return true; } catch { /* not a signature under this key */ }
    }
  }
  return false;
}

/**
 * Verifies a raw seal against pinned keys: config, text, chain keys (when
 * given), keyId, revocation, rotation, Ed25519 signature. Exported for
 * tooling and the RFC 8032 vector test.
 */
export async function verifyRestoreSeal(raw: unknown, options: { pinnedKeys: unknown; chainKeys?: ChainKeySet }): Promise<{ keyId: string; summary: RestoreSummary; summaryDigest: string }> {
  try {
    return verifyRestoreSealChecked(raw, options);
  } catch (error) {
    // Never let an uncoded error escape: anything unexpected is a malformed seal.
    if (isRestoreAnchorError(error)) throw error;
    return refuse(C.sealMalformed, "the seal could not be checked");
  }
}
function verifyRestoreSealChecked(raw: unknown, options: { pinnedKeys: unknown; chainKeys?: ChainKeySet }): { keyId: string; summary: RestoreSummary; summaryDigest: string } {
  // Order: malformed, then round-trip and schema, then config, then keys and signature.
  const seal = parseRestoreSealText(raw);
  assertPinnedKeys(options?.pinnedKeys);
  const pinnedKeys = options.pinnedKeys;
  const chainKeys = options.chainKeys;
  if (chainKeys) {
    if (chainKeys.ids.has(seal.keyId) || chainKeys.publicKeys.has(seal.keyId) || signedByChainKey(seal, chainKeys.publicKeys)) {
      refuse(C.validatorKey, "the seal names or is signed by a validator, oracle or faucet key");
    }
    if (pinnedKeys.some((key) => chainKeys.xCoordinates.has(key.publicKey))) refuse(C.validatorKey, "a validator, oracle or faucet key is pinned as a restore summary key");
  }
  const key = pinnedKeys.find((entry) => entry.keyId === seal.keyId);
  if (!key) return refuse(C.unknownKeyId, `keyId ${seal.keyId} is not pinned`);
  if (key.revoked) refuse(C.keyRevoked, `keyId ${seal.keyId} is revoked`);
  if (key.supersededAtHeight !== undefined && seal.summary.height >= key.supersededAtHeight) {
    refuse(C.keySuperseded, `keyId ${seal.keyId} was rotated out at height ${key.supersededAtHeight}`);
  }
  // Strict hex before decoding: anchored 128 lowercase hex (signature), 64 (public key).
  if (!HEX128.test(seal.signature) || !HEX64.test(key.publicKey)) refuse(C.invalidSignature, "the signature is not 64 bytes of lowercase hex");
  let valid = false;
  try { valid = cryptoVerify(null, restoreSealMessage(seal.keyId, seal.summary), ed25519PublicKeyObject(key.publicKey), Buffer.from(seal.signature, "hex")); } catch { valid = false; }
  if (!valid) refuse(C.invalidSignature, "the Ed25519 signature does not cover this keyId and these summary fields");
  return { keyId: seal.keyId, summary: seal.summary, summaryDigest: restoreSummaryDigest(seal.keyId, seal.summary) };
}

/** Runs one anchor read with a deadline; a hang, a throw, or anything else fails closed. */
async function boundedRead<T>(reader: () => Promise<T>, timeoutMs: number, timeoutCode: RestoreAnchorCode, failCode: RestoreAnchorCode, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(reader),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new RestoreAnchorError(timeoutCode, `${label} did not answer within ${timeoutMs} ms`)), timeoutMs); })
    ]);
  } catch (error) {
    if (isRestoreAnchorError(error)) throw new RestoreAnchorError(error.code, error.message.replace(/^restore refused \[[A-Z_]+\]: ?/, ""));
    // The reader's error is summarised, never attached as a cause.
    return refuse(failCode, `${label} could not be read`);
  } finally { if (timer) clearTimeout(timer); }
}

export interface RestoreBundleView {
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
  validatorSetHash: string;
  oracleSetHash: string;
  chainKeys: ChainKeySet;
}

/**
 * Pre-write checks (spec section 6), in order: anchor and config, seal
 * (text, schema, chain keys, keyId, revocation, rotation, signature),
 * superseded record, high-water record, chain, genesis, sets, height, live
 * quorum tip, bundle tip. Returns the verified seal.
 */
export async function verifyRestoreAnchor(anchor: RestoreAnchor | undefined, view: RestoreBundleView): Promise<{ summary: RestoreSummary; keyId: string; summaryDigest: string }> {
  if (!anchor || typeof anchor !== "object") return refuse(C.anchorMissing, "no independent restore anchor is configured");
  for (const reader of ["readSeal", "readSuperseded", "readHighWater", "readQuorumTip"] as const) {
    if (typeof anchor[reader] !== "function") refuse(C.anchorConfigInvalid, `the restore anchor has no ${reader}`);
  }
  const timeoutMs = anchor.timeoutMs ?? DEFAULT_RESTORE_READ_TIMEOUT_MS;
  if (!safeInt(timeoutMs, 1)) refuse(C.anchorConfigInvalid, "timeoutMs must be a positive integer");
  const raw = await boundedRead(() => anchor.readSeal(), timeoutMs, C.anchorTimeout, C.anchorUnavailable, "the sealed summary");
  if (raw === null || raw === undefined) {
    assertPinnedKeys(anchor.pinnedKeys);
    return refuse(C.sealMissing, "no sealed summary is published for this restore");
  }
  const verified = await verifyRestoreSeal(raw, { pinnedKeys: anchor.pinnedKeys, chainKeys: view.chainKeys });
  const { summary, summaryDigest } = verified;
  const superseded = await boundedRead(() => anchor.readSuperseded(), timeoutMs, C.anchorTimeout, C.anchorUnavailable, "the superseded record");
  if (!Array.isArray(superseded) || !superseded.every((entry) => isPlainObject(entry) && typeof entry.summaryDigest === "string" && typeof entry.tipHash === "string" && safeInt(entry.height, 0))) {
    refuse(C.anchorConfigInvalid, "the superseded record is malformed");
  }
  if (superseded.some((entry) => entry.summaryDigest === summaryDigest || (entry.height === summary.height && entry.tipHash === summary.tipHash))) {
    refuse(C.superseded, `the summary or its tip at height ${summary.height} is superseded`);
  }
  const highWater = await boundedRead(() => anchor.readHighWater(), timeoutMs, C.anchorTimeout, C.anchorUnavailable, "the high-water record");
  if (highWater !== null && highWater !== undefined && (!isPlainObject(highWater) || !safeInt(highWater.height, 0) || typeof highWater.summaryDigest !== "string" ||
    (highWater.tipHash !== undefined && !isHex32(highWater.tipHash)))) {
    refuse(C.anchorConfigInvalid, "the high-water record is malformed");
  }
  if (!highWater) refuse(C.highWaterConflict, "the high-water record has no seal for this chain (the seal was never recorded)");
  if (summary.height < highWater!.height) refuse(C.replayLowerHeight, `summary height ${summary.height} is below the high-water height ${highWater!.height}`);
  if (summary.height > highWater!.height || summaryDigest !== highWater!.summaryDigest) refuse(C.highWaterConflict, "the seal is not the one recorded at the high-water mark");
  if (highWater!.tipHash !== undefined && highWater!.tipHash !== summary.tipHash) refuse(C.highWaterConflict, "the high-water entry records another tip than the sealed summary");
  if (summary.chainId !== view.chainId) refuse(C.wrongChain, `summary is for ${summary.chainId}, the snapshot for ${view.chainId}`);
  if (summary.genesisHash !== view.genesisHash) refuse(C.genesisMismatch, "summary genesis hash differs from the snapshot genesis");
  if (summary.validatorSetHash !== view.validatorSetHash) refuse(C.validatorSetMismatch, "validator set differs from the summary");
  if (summary.oracleSetHash !== view.oracleSetHash) refuse(C.oracleSetMismatch, "oracle set differs from the summary");
  if (summary.height < view.height) refuse(C.stale, `summary height ${summary.height} is below the snapshot tip ${view.height}`);
  if (summary.height > view.height) refuse(C.aboveTip, `summary height ${summary.height} is above the snapshot tip ${view.height}`);
  const quorum = await boundedRead(() => anchor.readQuorumTip(summary.height), timeoutMs, C.quorumTipTimeout, C.quorumTipUnavailable, "the live quorum tip");
  if (!isPlainObject(quorum) || quorum.height !== summary.height || quorum.tipHash !== summary.tipHash) {
    refuse(C.quorumTipMismatch, `the live quorum does not report the sealed tip at height ${summary.height}`);
  }
  if (view.tipHash !== summary.tipHash) refuse(C.tipMismatch, "the snapshot tip differs from the sealed tip");
  return verified;
}

/** The read-only chain view the state fields are computed from. */
export interface RestoreChainView {
  height: number;
  tip: { hash: string; header: { stateRoot: string } };
  genesisSupplyAtoms(): number;
  getState(): { snapshot(): { accounts: Array<{ balanceAtoms: number }> } };
}
export interface RestoreStateFields { height: number; tipHash: string; stateRoot: string; totalSupplyAtoms: string; burnedAtoms: string; balancesAtoms?: string }

/** State fields of a chain at its tip. burned = total - balances - pending (pending is 0). */
export function restoreStateFieldsOf(chain: RestoreChainView): RestoreStateFields {
  const total = BigInt(chain.genesisSupplyAtoms());
  let balances = 0n;
  for (const account of chain.getState().snapshot().accounts) balances += BigInt(account.balanceAtoms);
  return { height: chain.height, tipHash: chain.tip.hash, stateRoot: chain.tip.header.stateRoot, totalSupplyAtoms: total.toString(), burnedAtoms: (total - balances).toString(), balancesAtoms: balances.toString() };
}

/** Post-replay checks, before the completion marker. */
export function assertReplayMatchesSummary(summary: RestoreSummary, replayed: RestoreStateFields & { balancesAtoms?: string }): void {
  if (replayed.height !== summary.height || replayed.tipHash !== summary.tipHash) refuse(C.tipMismatch, "the replayed tip differs from the sealed tip");
  if (replayed.stateRoot !== summary.stateRoot) refuse(C.stateMismatch, "the replayed state root differs from the sealed state root");
  if (replayed.totalSupplyAtoms !== summary.totalSupplyAtoms) refuse(C.supplyMismatch, "the replayed total supply differs from the sealed total supply");
  if (replayed.burnedAtoms !== summary.burnedAtoms) refuse(C.burnMismatch, "the replayed burned atoms differ from the sealed burned atoms");
  // Fixed supply: balances + pending + burned == MAX_SUPPLY_ATOMS (50,000,000 ZYN).
  const pending = 0n;
  if (replayed.balancesAtoms === undefined || BigInt(replayed.totalSupplyAtoms) !== BigInt(MAX_SUPPLY_ATOMS) ||
    BigInt(replayed.balancesAtoms) + pending + BigInt(replayed.burnedAtoms) !== BigInt(MAX_SUPPLY_ATOMS)) {
    refuse(C.supplyMismatch, "the replayed supply does not reconcile to the fixed 50,000,000 ZYN (balances + pending + burned)");
  }
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
  const { balancesAtoms: _balances, ...stateFields } = fields;
  const summary = {
    format: RESTORE_SUMMARY_FORMAT, chainId: input.chainId, genesisHash: input.genesisHash, ...stateFields,
    validatorSetHash: restoreValidatorSetHash(input.validators), oracleSetHash: restoreOracleSetHash(input.activityOracles),
    provenance: { ...input.provenance }, sealedAtMs: input.sealedAtMs
  };
  assertSummarySchema(summary);
  return summary;
}

// ---- pinned keys and the append-only record (repository files) -------------

export interface PinnedKeysFile { format: typeof RESTORE_KEYS_FORMAT; networkClass: "testnet"; purpose: typeof RESTORE_KEY_PURPOSE; keys: Array<{ keyId: string; publicKey: string; addedIn: string }> }
export type RecordEntry =
  | { index: number; prev: string; kind: "revoke-key"; keyId: string; reason: string }
  | { index: number; prev: string; kind: "supersede-key"; keyId: string; supersededAtHeight: number; reason: string }
  | { index: number; prev: string; kind: "supersede-summary"; summaryDigest: string; height: number; tipHash: string; reason: string };
export interface RecordFile { format: typeof RESTORE_RECORD_FORMAT; entries: RecordEntry[] }

// ---- byte-canonical trust files ---------------------------------------------

/**
 * First duplicated object key in a JSON text, or undefined. The text must
 * already be valid JSON (JSON.parse silently keeps the last duplicate).
 */
export function findDuplicateJsonKey(text: string): string | undefined {
  const stack: Array<{ keys: Set<string>; expectKey: boolean } | null> = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") { const top = stack.at(-1); if (top) top.expectKey = true; }
  }
  return undefined;
}

/** The one accepted byte form of a trust file: JSON.stringify(value, null, 2), LF, one trailing newline. */
export function canonicalTrustFileText(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n`; }

/**
 * Parses an l1/trust/*.json file strictly: valid JSON, no duplicate object
 * keys, and the bytes must equal canonicalTrustFileText of the parsed value
 * (2-space indentation in file key order, no other whitespace, no escape or
 * number variants, LF, one trailing newline). Any deviation is
 * RESTORE_ANCHOR_CONFIG_INVALID.
 */
export function parseTrustFileText(text: string, label: string): unknown {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse(C.anchorConfigInvalid, `${label} is not JSON`); }
  const duplicate = findDuplicateJsonKey(text);
  if (duplicate !== undefined) return refuse(C.anchorConfigInvalid, `${label} has a duplicate key ${JSON.stringify(duplicate)}`);
  if (canonicalTrustFileText(value) !== text) return refuse(C.anchorConfigInvalid, `${label} is not byte-canonical (expected JSON.stringify(value, null, 2) plus one trailing newline)`);
  return value;
}

/** l1/trust/t1-summary-keys.json: production keyIds are derived from the public key. */
export function parsePinnedKeysFile(value: unknown): PinnedKeysFile {
  const bad = (detail: string): never => refuse(C.anchorConfigInvalid, detail);
  if (!isPlainObject(value) || !exactKeys(value, ["format", "networkClass", "purpose", "keys"]) || value.format !== RESTORE_KEYS_FORMAT ||
    value.networkClass !== "testnet" || value.purpose !== RESTORE_KEY_PURPOSE || !Array.isArray(value.keys)) return bad("the pinned key file is malformed");
  for (const entry of value.keys) {
    if (!isPlainObject(entry) || !exactKeys(entry, ["keyId", "publicKey", "addedIn"]) || typeof entry.keyId !== "string" || typeof entry.publicKey !== "string" ||
      typeof entry.addedIn !== "string" || !PRINTABLE.test(entry.addedIn)) return bad("a pinned key entry is malformed");
    try { ed25519PublicKeyObject(entry.publicKey); } catch { return bad("a pinned public key is not a raw Ed25519 key"); }
    if (restoreKeyId(entry.publicKey) !== entry.keyId) return bad("a pinned keyId does not match its public key");
  }
  return value as unknown as PinnedKeysFile;
}

export function recordEntryHash(entry: unknown): string { return sha256Hex(canonicalJson(entry)); }

/** l1/trust/t1-summary-record.json: append-only (index + prev hash chain). */
export function parseRecordFile(value: unknown): RecordFile {
  if (!isPlainObject(value) || !exactKeys(value, ["format", "entries"]) || value.format !== RESTORE_RECORD_FORMAT || !Array.isArray(value.entries)) return refuse(C.anchorConfigInvalid, "the record file is malformed");
  let prev = ZERO_HASH;
  for (const [position, entry] of value.entries.entries()) {
    const bad = (detail: string): never => refuse(C.anchorConfigInvalid, `record entry ${position + 1}: ${detail}`);
    if (!isPlainObject(entry)) return bad("not an object");
    if (entry.index !== position + 1) return bad("index is not the next index (an entry was removed or reordered)");
    if (entry.prev !== prev) return bad("prev does not match the previous entry (the record was edited)");
    if (typeof entry.reason !== "string" || !PRINTABLE.test(entry.reason)) return bad("reason is missing");
    if (entry.kind === "revoke-key") {
      if (!exactKeys(entry, ["index", "prev", "kind", "keyId", "reason"]) || typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId)) return bad("malformed revoke-key");
    } else if (entry.kind === "supersede-key") {
      if (!exactKeys(entry, ["index", "prev", "kind", "keyId", "supersededAtHeight", "reason"]) || typeof entry.keyId !== "string" || !KEY_ID.test(entry.keyId) || !safeInt(entry.supersededAtHeight, 0)) return bad("malformed supersede-key");
    } else if (entry.kind === "supersede-summary") {
      if (!exactKeys(entry, ["index", "prev", "kind", "summaryDigest", "height", "tipHash", "reason"]) || !isHex32(entry.summaryDigest) || !safeInt(entry.height, 0) || !isHex32(entry.tipHash)) return bad("malformed supersede-summary");
    } else return bad("unknown kind");
    prev = recordEntryHash(entry);
  }
  return value as unknown as RecordFile;
}

type NewRecordEntry =
  | { kind: "revoke-key"; keyId: string; reason: string }
  | { kind: "supersede-key"; keyId: string; supersededAtHeight: number; reason: string }
  | { kind: "supersede-summary"; summaryDigest: string; height: number; tipHash: string; reason: string };
/** Returns a new record with one entry appended (index and prev filled in). Never edits existing entries. */
export function appendRecordEntry(record: RecordFile, entry: NewRecordEntry): RecordFile {
  const current = parseRecordFile(record);
  const last = current.entries.at(-1);
  const next = { index: current.entries.length + 1, prev: last ? recordEntryHash(last) : ZERO_HASH, ...entry } as RecordEntry;
  return parseRecordFile({ format: RESTORE_RECORD_FORMAT, entries: [...current.entries, next] });
}

/** Pinned keys with revocations / rotations applied, and the superseded list. */
export function restoreTrustFromFiles(keysFile: unknown, recordFile: unknown): { pinnedKeys: PinnedRestoreKey[]; superseded: SupersededEntry[] } {
  const keys = parsePinnedKeysFile(keysFile);
  const record = parseRecordFile(recordFile);
  const revoked = new Set<string>();
  const rotated = new Map<string, number>();
  for (const entry of record.entries) {
    if (entry.kind === "revoke-key") revoked.add(entry.keyId);
    if (entry.kind === "supersede-key") rotated.set(entry.keyId, Math.min(entry.supersededAtHeight, rotated.get(entry.keyId) ?? Number.MAX_SAFE_INTEGER));
  }
  return {
    pinnedKeys: keys.keys.map(({ keyId, publicKey }) => ({ keyId, publicKey, revoked: revoked.has(keyId), ...(rotated.has(keyId) ? { supersededAtHeight: rotated.get(keyId)! } : {}) })),
    superseded: record.entries.flatMap((entry) => entry.kind === "supersede-summary" ? [{ summaryDigest: entry.summaryDigest, height: entry.height, tipHash: entry.tipHash }] : [])
  };
}

// ---- the separate append-only high-water record -----------------------------

export const RESTORE_HIGH_WATER_FORMAT = "zyronchain-restore-summary-high-water-v1";
export interface HighWaterEntry { index: number; prev: string; chainId: string; height: number; tipHash: string; summaryDigest: string; reason: string }
export interface HighWaterFile { format: typeof RESTORE_HIGH_WATER_FORMAT; entries: HighWaterEntry[] }

/**
 * The high-water record is its own append-only log (index + prev hash chain;
 * never derived from the superseded list). Each entry records one seal
 * (chainId, height, tipHash, summaryDigest) that was accepted for publication
 * by PR. Its effective value for a chain is the highest entry whose seal is
 * not superseded: a supersede-summary entry matches it by summaryDigest, or
 * by height and tipHash (a superseded tip), so superseding the tip of the
 * H+50 seal makes the high-water resolve to the seal at H. A seal enters the
 * record in the same PR that publishes it, before any restore uses it; a seal
 * above the effective value is refused (RESTORE_SUMMARY_HIGH_WATER_CONFLICT),
 * one below it is a replay (RESTORE_SUMMARY_REPLAY_LOWER_HEIGHT).
 */
export function parseHighWaterFile(value: unknown): HighWaterFile {
  if (!isPlainObject(value) || !exactKeys(value, ["format", "entries"]) || value.format !== RESTORE_HIGH_WATER_FORMAT || !Array.isArray(value.entries)) return refuse(C.anchorConfigInvalid, "the high-water file is malformed");
  let prev = ZERO_HASH;
  const digests = new Set<string>();
  for (const [position, entry] of value.entries.entries()) {
    const bad = (detail: string): never => refuse(C.anchorConfigInvalid, `high-water entry ${position + 1}: ${detail}`);
    if (!isPlainObject(entry) || !exactKeys(entry, ["index", "prev", "chainId", "height", "tipHash", "summaryDigest", "reason"])) return bad("malformed");
    if (entry.index !== position + 1) return bad("index is not the next index (an entry was removed or reordered)");
    if (entry.prev !== prev) return bad("prev does not match the previous entry (the record was edited)");
    if (!isTestnetChainId(entry.chainId) || !safeInt(entry.height, 1) || !isHex32(entry.tipHash) || !isHex32(entry.summaryDigest) ||
      typeof entry.reason !== "string" || !PRINTABLE.test(entry.reason)) return bad("malformed");
    if (digests.has(entry.summaryDigest)) return bad("a seal is recorded twice");
    digests.add(entry.summaryDigest);
    prev = sha256Hex(canonicalJson(entry));
  }
  return value as unknown as HighWaterFile;
}

/**
 * Effective high-water of a chain: the highest recorded seal not superseded,
 * or null. It carries the entry's tipHash, which the verifier cross-checks
 * against the sealed summary. Two live (not superseded) entries at the same
 * height with different tips are a conflict (RESTORE_SUMMARY_HIGH_WATER_CONFLICT).
 */
export function highWaterFor(file: HighWaterFile, chainId: string, superseded: readonly SupersededEntry[] = []): HighWater | null {
  const supersededDigests = new Set(superseded.map((entry) => entry.summaryDigest));
  const supersededTips = new Set(superseded.map((entry) => `${entry.height}:${entry.tipHash}`));
  let best: HighWaterEntry | undefined;
  for (const entry of file.entries) {
    if (entry.chainId !== chainId || supersededDigests.has(entry.summaryDigest) || supersededTips.has(`${entry.height}:${entry.tipHash}`)) continue;
    if (best && entry.height === best.height && entry.tipHash !== best.tipHash) refuse(C.highWaterConflict, `the high-water record has two live seals with different tips at height ${entry.height}`);
    if (!best || entry.height > best.height) best = entry;
  }
  return best ? { height: best.height, summaryDigest: best.summaryDigest, tipHash: best.tipHash } : null;
}

export function appendHighWaterEntry(file: HighWaterFile, entry: { chainId: string; height: number; tipHash: string; summaryDigest: string; reason: string }): HighWaterFile {
  const current = parseHighWaterFile(file);
  const last = current.entries.at(-1);
  return parseHighWaterFile({ format: RESTORE_HIGH_WATER_FORMAT, entries: [...current.entries, { index: current.entries.length + 1, prev: last ? sha256Hex(canonicalJson(last)) : ZERO_HASH, ...entry }] });
}

// ---- the pinned boot configuration -------------------------------------------

export const RESTORE_CONFIG_FORMAT = "zyronchain-restore-anchor-config-v1";
export interface RestoreAnchorConfig {
  format: typeof RESTORE_CONFIG_FORMAT;
  chainId: string | null;
  quorum: { threshold: number; timeoutMs: number; validators: Array<{ publicKey: string; url: string }> };
}

/**
 * True for hosts or addresses that must never be a production quorum source:
 * localhost names, loopback, unspecified, private (RFC 1918), CGNAT,
 * link-local, benchmarking (198.18.0.0/15), documentation, multicast and
 * reserved IPv4; IPv6 loopback, unspecified, IPv4-mapped / IPv4-compatible
 * (::/96 and ::ffff:0:0/96), NAT64 (64:ff9b::/96 and 64:ff9b:1::/48), 6to4
 * (2002::/16), Teredo (2001::/32), documentation (2001:db8::/32), unique-local
 * and link-local addresses; and internal-only names. Names are checked
 * here; their resolved addresses are checked by the quorum reader
 * (scripts/open-testnet/restore-anchor.mjs), so a public name that resolves to
 * a private address (nip.io style) is refused too.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host === "") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
  }
  if (host.includes(":")) {
    return host.startsWith("::") || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^ff/.test(host) || /^64:ff9b:/.test(host) ||
      /^2002:/.test(host) || /^2001:(0{0,4}:|:)/.test(host) || /^2001:db8:/.test(host) || /^0{1,4}:/.test(host);
  }
  return false;
}

/** Origin of a quorum source URL (scheme://host:port), or null if it is not a URL. */
export function quorumSourceOrigin(url: string): string | null {
  try { return new URL(url).origin; } catch { return null; }
}

// Second-level labels under a two-letter country TLD that act as public
// suffixes (example.co.uk, example.com.au). A small fixed list, no dependency.
const CC_SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gov", "net", "org", "ne", "or", "go", "gen", "ltd", "plc", "nic", "mil"]);

/**
 * Site of a quorum source URL for the "at least two distinct sources" rule,
 * or null if it is not a URL. The host is lowercased, trailing dots, port and
 * scheme are dropped, and a DNS name collapses to its registrable domain with
 * a simple eTLD+1 rule: the last two labels, or the last three when the
 * second-to-last label is a common second-level suffix under a two-letter
 * country TLD. An IP literal is its own site. So v1.example.com,
 * v2.example.com:8443 and example.com. are one site. The rule is deliberately
 * conservative: tenants of one shared hosting suffix (x.onrender.com,
 * y.onrender.com) also count as one site. The local loopback test fixture
 * (http://127.0.0.1:<port>, accepted only with the fixture marker) keeps
 * scheme://host:port so a local multi-port fixture still has distinct sources.
 */
export function quorumSourceSite(url: string): string | null {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") return parsed.origin;
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const take = labels.at(-1)!.length === 2 && CC_SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * Strict parse of l1/trust/restore-anchor-config.json. The shipped
 * placeholder has no sources. Production sources are https URLs on public
 * hosts, every URL distinct, from at least two distinct sites
 * (quorumSourceSite). Loopback
 * (http://127.0.0.1) sources are accepted only with allowLoopbackFixture,
 * which only the local test / smoke fixture path sets.
 */
export function parseRestoreAnchorConfig(value: unknown, { allowLoopbackFixture = false }: { allowLoopbackFixture?: boolean } = {}): RestoreAnchorConfig {
  const bad = (detail: string): never => refuse(C.anchorConfigInvalid, detail);
  if (!isPlainObject(value) || !exactKeys(value, ["format", "chainId", "quorum"]) || value.format !== RESTORE_CONFIG_FORMAT) return bad("the restore anchor config is malformed");
  if (value.chainId !== null && !isTestnetChainId(value.chainId)) return bad("chainId must be an open-testnet chain ID or null");
  const quorum = value.quorum;
  if (!isPlainObject(quorum) || !exactKeys(quorum, ["threshold", "timeoutMs", "validators"]) || !Array.isArray(quorum.validators) ||
    !safeInt(quorum.threshold, 0) || !safeInt(quorum.timeoutMs, 1) || quorum.timeoutMs > 120_000) return bad("quorum must be { threshold, timeoutMs, validators }");
  const keys = new Set<string>();
  const urls = new Set<string>();
  const sites = new Set<string>();
  for (const validator of quorum.validators) {
    if (!isPlainObject(validator) || !exactKeys(validator, ["publicKey", "url"]) || typeof validator.publicKey !== "string" || !/^[0-9a-f]{128}$/.test(validator.publicKey) ||
      typeof validator.url !== "string" || !/^https?:\/\/[!-~]{1,500}$/.test(validator.url)) return bad("a quorum validator entry is malformed");
    let parsed: URL;
    try { parsed = new URL(validator.url); } catch { return bad("a quorum validator URL is not a URL"); }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return bad("a quorum validator URL must not carry credentials, a query or a fragment");
    const loopbackFixture = allowLoopbackFixture && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
    if (!loopbackFixture && (parsed.protocol !== "https:" || isPrivateOrLoopbackHost(parsed.hostname))) {
      return bad("a quorum validator URL must be https on a public host (loopback, localhost and private hosts only in the local test fixture)");
    }
    if (keys.has(validator.publicKey)) return bad("a quorum validator is listed twice");
    const normalized = parsed.href.replace(/\/+$/, "");
    if (urls.has(normalized)) return bad("two quorum validators share one URL");
    keys.add(validator.publicKey);
    urls.add(normalized);
    sites.add(quorumSourceSite(validator.url)!);
  }
  if (quorum.validators.length > 0 && sites.size < 2) return bad("the quorum validators must come from at least two distinct sites (registrable hosts; port, trailing-dot and subdomain variants are one site)");
  const n = quorum.validators.length;
  if (n > 0 && (n < 3 || quorum.threshold < Math.floor((2 * n) / 3) + 1 || quorum.threshold > n)) {
    return bad(`the quorum threshold must be between floor(2n/3)+1 and n, with at least 3 validators (n = ${n})`);
  }
  return value as unknown as RestoreAnchorConfig;
}
