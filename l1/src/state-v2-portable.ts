import { canonicalJson } from "./codec.js";
import {
  assertStateV2NodeRecordSelfConsistent,
  assertStateV2SemanticKeyShape,
  reconstructStateV2PortableView,
  SparseMerkleState,
  stateV2FromLedgerSnapshot,
  stateV2KeyPreimages,
  type StateV2GovernanceSnapshot,
  type StateV2NodeRecord,
  type StateV2PortableView
} from "./state-v2.js";
import type { LedgerSnapshot } from "./state.js";

export const MAX_PORTABLE_STATE_NODES = 2_000_000;
export const MAX_PORTABLE_STATE_KEYS = 1_000_000;
export const MAX_PORTABLE_LEAF_VALUE_BYTES = 64 * 1024;

export interface StateV2PortableBundleV1 {
  version: 1;
  root: string;
  records: StateV2NodeRecord[];
  keyPreimages: string[];
}

export interface ValidatedStateV2PortableBundle {
  bundle: StateV2PortableBundleV1;
  state: SparseMerkleState;
  view: StateV2PortableView;
}

/** Creates a self-contained record/preimage bundle without adding a new trust root. */
export function createStateV2PortableBundle(
  state: SparseMerkleState,
  ledger: LedgerSnapshot,
  governance: StateV2GovernanceSnapshot
): StateV2PortableBundleV1 {
  if (stateV2FromLedgerSnapshot(ledger, governance).root() !== state.root()) {
    throw new Error("Portable State v2 source view does not match state root");
  }
  const keyPreimages = stateV2KeyPreimages(ledger, governance);
  const reconstructed = reconstructStateV2PortableView(state, keyPreimages);
  if (canonicalJson(reconstructed.ledger) !== canonicalJson(ledger) ||
      canonicalJson(reconstructed.governance) !== canonicalJson(governance)) {
    throw new Error("Portable State v2 source view is not canonical");
  }
  const records = state.nodeRecords();
  if (records.length > MAX_PORTABLE_STATE_NODES || keyPreimages.length > MAX_PORTABLE_STATE_KEYS) {
    throw new Error("Portable State v2 bundle exceeds record limits");
  }
  return { version: 1, root: state.root(), records, keyPreimages };
}

/**
 * Validates an untrusted portable bundle against an already authenticated state
 * root. Every supplied node must be reachable from that root; extra valid-looking
 * nodes are rejected rather than silently ignored.
 */
export function validateStateV2PortableBundle(
  value: unknown,
  expectedRoot: string
): ValidatedStateV2PortableBundle {
  if (!/^[0-9a-f]{64}$/.test(expectedRoot)) throw new Error("Invalid expected State v2 root");
  assertExactRecord(value, ["version", "root", "records", "keyPreimages"], "portable State v2 bundle");
  if (value.version !== 1 || value.root !== expectedRoot || !Array.isArray(value.records) ||
      value.records.length < 1 || value.records.length > MAX_PORTABLE_STATE_NODES ||
      !Array.isArray(value.keyPreimages) || value.keyPreimages.length < 1 ||
      value.keyPreimages.length > MAX_PORTABLE_STATE_KEYS) {
    throw new Error("Invalid portable State v2 bundle");
  }
  const records = value.records.map(parseNodeRecord);
  const keyPreimages = value.keyPreimages.map(parsePortableStateKeyPreimage);
  const state = SparseMerkleState.fromNodeRecords(expectedRoot, records);
  const reachableHashes = state.reachableNodeHashes();
  if (reachableHashes.size !== records.length) throw new Error("Portable State v2 bundle contains unreachable nodes");
  if (records.some((record) => !reachableHashes.has(record.hash))) {
    throw new Error("Portable State v2 bundle contains uncommitted nodes");
  }
  const view = reconstructStateV2PortableView(state, keyPreimages);
  return {
    // Return independent record objects without structured-cloning immutable
    // strings (especially valueJson) a second time at peak import memory.
    bundle: { version: 1, root: expectedRoot, records: records.map(copyNodeRecord), keyPreimages: [...keyPreimages] },
    state,
    view
  };
}

/** Shape-checks one untrusted key preimage (also used per state-sync chunk). */
export function parsePortableStateKeyPreimage(key: unknown): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new Error("Invalid portable State v2 key preimage");
  assertStateV2SemanticKeyShape(key);
  return key;
}

/**
 * Shape-checks one untrusted node record and its position-independent hash
 * self-consistency, so a state-sync client can reject a bad chunk as soon as
 * it arrives (F-09(b)). Root reachability is still checked on the full bundle.
 */
export function parsePortableStateNodeRecord(value: unknown): StateV2NodeRecord {
  const record = parseNodeRecord(value);
  assertStateV2NodeRecordSelfConsistent(record);
  if (record.kind === "leaf") assertCanonicalLeafValueJson(record.valueJson);
  return record;
}

/**
 * Round-4 PR980: a leaf whose valueJson is not JSON, or not the canonical
 * encoding the writer produces, can never be part of a valid state. Reject it
 * at the chunk that carries it (the hash self-consistency check alone accepts
 * any bytes whose hash the peer recomputed).
 */
function assertCanonicalLeafValueJson(valueJson: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(valueJson);
  } catch {
    throw new Error("Invalid portable State v2 leaf value");
  }
  let canonical: string;
  try {
    canonical = canonicalJson(parsed);
  } catch {
    throw new Error("Invalid portable State v2 leaf value");
  }
  if (canonical !== valueJson) throw new Error("Noncanonical portable State v2 leaf value");
}

function copyNodeRecord(record: StateV2NodeRecord): StateV2NodeRecord {
  return record.kind === "leaf"
    ? { kind: "leaf", hash: record.hash, keyHash: record.keyHash, valueHash: record.valueHash, valueJson: record.valueJson }
    : { kind: "branch", hash: record.hash, leftHash: record.leftHash, rightHash: record.rightHash };
}

function parseNodeRecord(value: unknown): StateV2NodeRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid portable State v2 node");
  const record = value as Record<string, unknown>;
  if (record.kind === "leaf") {
    assertExactRecord(record, ["kind", "hash", "keyHash", "valueHash", "valueJson"], "portable State v2 leaf");
    if (!isHash(record.hash) || !isHash(record.keyHash) || !isHash(record.valueHash) ||
        typeof record.valueJson !== "string" || Buffer.byteLength(record.valueJson, "utf8") > MAX_PORTABLE_LEAF_VALUE_BYTES) {
      throw new Error("Invalid portable State v2 leaf");
    }
    return {
      kind: "leaf", hash: record.hash, keyHash: record.keyHash,
      valueHash: record.valueHash, valueJson: record.valueJson
    };
  }
  if (record.kind === "branch") {
    assertExactRecord(record, ["kind", "hash", "leftHash", "rightHash"], "portable State v2 branch");
    if (!isHash(record.hash) || !isNullableHash(record.leftHash) || !isNullableHash(record.rightHash)) {
      throw new Error("Invalid portable State v2 branch");
    }
    return { kind: "branch", hash: record.hash, leftHash: record.leftHash, rightHash: record.rightHash };
  }
  throw new Error("Invalid portable State v2 node kind");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isNullableHash(value: unknown): value is string | null {
  return value === null || isHash(value);
}

function assertExactRecord(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${name} fields`);
  }
}
