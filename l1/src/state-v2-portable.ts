import { canonicalJson } from "./codec.js";
import {
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
  const keyPreimages = value.keyPreimages.map((key) => {
    if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new Error("Invalid portable State v2 key preimage");
    return key;
  });
  const state = SparseMerkleState.fromNodeRecords(expectedRoot, records);
  const reachable = state.nodeRecords();
  if (reachable.length !== records.length) throw new Error("Portable State v2 bundle contains unreachable nodes");
  const reachableHashes = new Set(reachable.map((record) => record.hash));
  if (records.some((record) => !reachableHashes.has(record.hash))) {
    throw new Error("Portable State v2 bundle contains uncommitted nodes");
  }
  const view = reconstructStateV2PortableView(state, keyPreimages);
  return {
    bundle: { version: 1, root: expectedRoot, records: structuredClone(records), keyPreimages: [...keyPreimages] },
    state,
    view
  };
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
