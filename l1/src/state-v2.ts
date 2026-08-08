import { createHash } from "node:crypto";

import { canonicalJson } from "./codec.js";
import type { LedgerSnapshot, LedgerState } from "./state.js";
import { MAX_SUPPLY_ATOMS, type Address, type Transaction, type Validator } from "./types.js";

const TREE_DEPTH = 256;
const KEY_DOMAIN = Buffer.from("ZyronChain/state-v2/key\0", "utf8");
const VALUE_DOMAIN = Buffer.from("ZyronChain/state-v2/value\0", "utf8");
const LEAF_DOMAIN = Buffer.from("ZyronChain/state-v2/leaf\0", "utf8");
const EMPTY_LEAF_DOMAIN = Buffer.from("ZyronChain/state-v2/empty-leaf\0", "utf8");
const BRANCH_DOMAIN = Buffer.from("ZyronChain/state-v2/branch\0", "utf8");

interface LeafNode {
  kind: "leaf";
  hash: string;
  keyHash: string;
  valueHash: string;
  valueJson: string;
}

interface BranchNode {
  kind: "branch";
  hash: string;
  left: TreeNode | undefined;
  right: TreeNode | undefined;
}

type TreeNode = LeafNode | BranchNode;

interface PendingRecordChunk {
  records: readonly StateV2NodeRecord[];
  previous: PendingRecordChunk | undefined;
}

export interface SparseMerkleProof {
  version: 1;
  keyHash: string;
  valueHash: string | null;
  siblings: string[];
}

export type StateV2NodeRecord =
  | { kind: "leaf"; hash: string; keyHash: string; valueHash: string; valueJson: string }
  | { kind: "branch"; hash: string; leftHash: string | null; rightHash: string | null };

const EMPTY_HASHES = buildEmptyHashes();

/**
 * Protocol-v2 authenticated key/value primitive.
 *
 * The structure is immutable: every set() creates only the 256 nodes on the
 * changed key path and structurally shares the untouched subtrees. This keeps
 * fork/update cost independent of total account cardinality and lets block
 * validation hold a candidate state without mutating the finalized state.
 */
export class SparseMerkleState {
  private constructor(
    private readonly rootNode?: TreeNode,
    private readonly pendingRecordHead?: PendingRecordChunk
  ) {}

  static empty(): SparseMerkleState {
    return new SparseMerkleState();
  }

  static fromNodeRecords(rootHash: string, records: Iterable<StateV2NodeRecord>): SparseMerkleState {
    if (!/^[0-9a-f]{64}$/.test(rootHash)) throw new Error("Invalid State v2 root hash");
    if (rootHash === EMPTY_HASHES[0]) return SparseMerkleState.empty();
    const byHash = new Map<string, StateV2NodeRecord>();
    for (const record of records) {
      if (byHash.has(record.hash)) throw new Error("Duplicate State v2 node record");
      byHash.set(record.hash, structuredClone(record));
    }
    const depths = new Map<string, number>();
    const visiting = new Set<string>();
    const hydrate = (hash: string, depth: number): TreeNode => {
      const previousDepth = depths.get(hash);
      if (previousDepth !== undefined && previousDepth !== depth) throw new Error("State v2 node reused at inconsistent depth");
      depths.set(hash, depth);
      if (visiting.has(hash)) throw new Error("Cyclic State v2 node graph");
      const record = byHash.get(hash);
      if (!record) throw new Error("Missing State v2 node record");
      visiting.add(hash);
      let node: TreeNode;
      if (record.kind === "leaf") {
        if (!/^[0-9a-f]{64}$/.test(record.keyHash) || !/^[0-9a-f]{64}$/.test(record.valueHash)) {
          throw new Error("Invalid State v2 leaf record");
        }
        const parsed = JSON.parse(record.valueJson) as unknown;
        if (canonicalJson(parsed) !== record.valueJson ||
            hashWithDomain(VALUE_DOMAIN, Buffer.from(record.valueJson, "utf8")) !== record.valueHash) {
          throw new Error("Corrupt State v2 leaf value");
        }
        node = leafNodeAtDepth(Buffer.from(record.keyHash, "hex"), record.keyHash, record.valueHash, record.valueJson, depth);
      } else {
        if (depth >= TREE_DEPTH) throw new Error("State v2 branch below tree depth");
        const left = record.leftHash === null ? undefined : hydrate(record.leftHash, depth + 1);
        const right = record.rightHash === null ? undefined : hydrate(record.rightHash, depth + 1);
        node = {
          kind: "branch",
          left,
          right,
          hash: branchHash(left?.hash ?? EMPTY_HASHES[depth + 1]!, right?.hash ?? EMPTY_HASHES[depth + 1]!)
        };
      }
      visiting.delete(hash);
      if (node.hash !== record.hash) throw new Error("State v2 node hash mismatch");
      return node;
    };
    const root = hydrate(rootHash, 0);
    return new SparseMerkleState(root);
  }

  root(): string {
    return this.rootNode?.hash ?? EMPTY_HASHES[0]!;
  }

  set(key: string, value: unknown): SparseMerkleState {
    if (!key.length) throw new Error("State v2 key must not be empty");
    const keyHash = hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
    const valueJson = canonicalJson(value);
    const valueHash = hashWithDomain(VALUE_DOMAIN, Buffer.from(valueJson, "utf8"));
    const keyBytes = Buffer.from(keyHash, "hex");
    const created: StateV2NodeRecord[] = [];
    const rootNode = updateNode(this.rootNode, 0, keyBytes, keyHash, valueHash, valueJson, created);
    return new SparseMerkleState(rootNode, { records: created, previous: this.pendingRecordHead });
  }

  get(key: string): unknown | undefined {
    if (!key.length) throw new Error("State v2 key must not be empty");
    const keyHash = hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
    const leaf = findLeaf(this.rootNode, Buffer.from(keyHash, "hex"), keyHash);
    return leaf ? JSON.parse(leaf.valueJson) as unknown : undefined;
  }

  nodeRecords(): StateV2NodeRecord[] {
    const records: StateV2NodeRecord[] = [];
    const seen = new Set<string>();
    const visit = (node: TreeNode | undefined): void => {
      if (!node || seen.has(node.hash)) return;
      seen.add(node.hash);
      if (node.kind === "leaf") {
        records.push({
          kind: "leaf", hash: node.hash, keyHash: node.keyHash,
          valueHash: node.valueHash, valueJson: node.valueJson
        });
        return;
      }
      visit(node.left);
      visit(node.right);
      records.push({
        kind: "branch", hash: node.hash,
        leftHash: node.left?.hash ?? null, rightHash: node.right?.hash ?? null
      });
    };
    visit(this.rootNode);
    return records;
  }

  /** Nodes materialized since the last persistence checkpoint. */
  pendingNodeRecords(): StateV2NodeRecord[] {
    const unique = new Map<string, StateV2NodeRecord>();
    for (let chunk = this.pendingRecordHead; chunk; chunk = chunk.previous) {
      for (const record of chunk.records) {
        if (!unique.has(record.hash)) unique.set(record.hash, structuredClone(record));
      }
    }
    return [...unique.values()];
  }

  /**
   * Return the same authenticated state with an empty persistence delta.
   * Disk stores call this only after the root and every pending node are durable.
   */
  persistenceCheckpoint(): SparseMerkleState {
    return new SparseMerkleState(this.rootNode);
  }

  prove(key: string): SparseMerkleProof {
    if (!key.length) throw new Error("State v2 key must not be empty");
    const keyHash = hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
    const keyBytes = Buffer.from(keyHash, "hex");
    const siblings: string[] = [];
    let node = this.rootNode;
    for (let depth = 0; depth < TREE_DEPTH; depth += 1) {
      if (!node) {
        for (let rest = depth; rest < TREE_DEPTH; rest += 1) siblings.push(EMPTY_HASHES[rest + 1]!);
        break;
      }
      if (node.kind === "leaf") {
        appendCompressedLeafProof(siblings, node, keyBytes, depth);
        break;
      }
      const branch = node;
      if (bitAt(keyBytes, depth) === 0) {
        siblings.push(branch?.right?.hash ?? EMPTY_HASHES[depth + 1]!);
        node = branch?.left;
      } else {
        siblings.push(branch?.left?.hash ?? EMPTY_HASHES[depth + 1]!);
        node = branch?.right;
      }
    }
    const valueHash = findLeafValueHash(this.rootNode, keyBytes, keyHash);
    return { version: 1, keyHash, valueHash, siblings };
  }
}

export function verifySparseMerkleProof(
  root: string,
  key: string,
  value: unknown | null,
  proof: SparseMerkleProof
): boolean {
  try {
    if (!/^[0-9a-f]{64}$/.test(root) || proof.version !== 1 || proof.siblings.length !== TREE_DEPTH) return false;
    const keyHash = hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
    if (proof.keyHash !== keyHash || proof.siblings.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) return false;
    const keyBytes = Buffer.from(keyHash, "hex");
    let current: string;
    if (value === null) {
      if (proof.valueHash !== null) return false;
      current = EMPTY_HASHES[TREE_DEPTH]!;
    } else {
      const valueHash = hashWithDomain(VALUE_DOMAIN, Buffer.from(canonicalJson(value), "utf8"));
      if (proof.valueHash !== valueHash) return false;
      current = leafHash(keyHash, valueHash);
    }
    for (let depth = TREE_DEPTH - 1; depth >= 0; depth -= 1) {
      const sibling = proof.siblings[depth]!;
      current = bitAt(keyBytes, depth) === 0
        ? branchHash(current, sibling)
        : branchHash(sibling, current);
    }
    return current === root;
  } catch {
    return false;
  }
}

/** Deterministic one-time protocol-v2 migration from the finalized v1 ledger. */
export interface StateV2GovernanceSnapshot {
  validatorSchedule: Array<{ activationHeight: number; validators: Validator[] }>;
  protocolSchedule: Array<{ activationHeight: number; protocolVersion: number }>;
}

export function stateV2FromLedgerSnapshot(
  snapshot: LedgerSnapshot,
  governance?: StateV2GovernanceSnapshot
): SparseMerkleState {
  let state = SparseMerkleState.empty();
  for (const account of [...snapshot.accounts].sort((a, b) => a.address.localeCompare(b.address))) {
    state = state.set(accountKey(account.address), {
      balanceAtoms: account.balanceAtoms,
      nonce: account.nonce
    });
  }
  for (const epoch of [...snapshot.settledActivityEpochs].sort((a, b) => a - b)) {
    state = state.set(activityEpochKey(epoch), { settled: true });
  }
  if (governance) {
    for (const entry of [...governance.validatorSchedule].sort((a, b) => a.activationHeight - b.activationHeight)) {
      state = state.set(validatorScheduleKey(entry.activationHeight), { validators: entry.validators });
    }
    for (const entry of [...governance.protocolSchedule].sort((a, b) => a.activationHeight - b.activationHeight)) {
      state = state.set(protocolScheduleKey(entry.activationHeight), { protocolVersion: entry.protocolVersion });
    }
  }
  return state;
}

/** Apply only keys touched by an already-validated transaction to protocol-v2 state. */
export function updateStateV2FromTransaction(
  state: SparseMerkleState,
  ledger: LedgerState,
  tx: Transaction
): SparseMerkleState {
  const addresses = new Set<Address>();
  addresses.add(tx.sender);
  if (tx.kind === "transfer") addresses.add(tx.receiver);
  else if (tx.kind === "activity_settlement") {
    for (const entry of tx.entries) addresses.add(entry.receiver);
  }
  let next = state;
  for (const address of addresses) {
    next = next.set(accountKey(address), {
      balanceAtoms: ledger.balance(address),
      nonce: ledger.nonce(address)
    });
  }
  if (tx.kind === "activity_settlement") {
    next = next.set(activityEpochKey(tx.epoch), { settled: true });
  }
  return next;
}

/** Apply protocol-v2 ledger semantics directly to authenticated state. */
export function applyStateV2Transaction(
  state: SparseMerkleState,
  tx: Transaction,
  activityPool: Address
): SparseMerkleState {
  if (tx.kind === "transfer") {
    requireStateV2Nonce(state, tx.sender, tx.nonce);
    const total = tx.amountAtoms + tx.feeAtoms;
    if (!Number.isSafeInteger(total)) throw new Error("Insufficient balance");
    let next = debitStateV2(state, tx.sender, total);
    next = creditStateV2(next, tx.receiver, tx.amountAtoms);
    return setStateV2Nonce(next, tx.sender, tx.nonce);
  }
  if (tx.kind === "activity_settlement") {
    if (tx.sender !== activityPool) throw new Error("Invalid activity pool sender");
    if (state.get(activityEpochKey(tx.epoch)) !== undefined) throw new Error("Activity epoch already settled");
    requireStateV2Nonce(state, activityPool, tx.nonce);
    const total = tx.entries.reduce((sum, entry) => {
      const next = sum + entry.amountAtoms;
      if (!Number.isSafeInteger(next)) throw new Error("Activity total overflow");
      return next;
    }, 0);
    let next = debitStateV2(state, activityPool, total);
    for (const entry of tx.entries) next = creditStateV2(next, entry.receiver, entry.amountAtoms);
    next = setStateV2Nonce(next, activityPool, tx.nonce);
    return next.set(activityEpochKey(tx.epoch), { settled: true });
  }
  requireStateV2Nonce(state, tx.sender, tx.nonce);
  let next = setStateV2Nonce(state, tx.sender, tx.nonce);
  if (tx.kind === "validator_update") {
    next = next.set(validatorScheduleKey(tx.activationHeight), { validators: tx.validators });
  } else if (tx.kind === "protocol_upgrade") {
    next = next.set(protocolScheduleKey(tx.activationHeight), { protocolVersion: tx.protocolVersion });
  }
  return next;
}

interface StateV2Account {
  balanceAtoms: number;
  nonce: number;
}

function stateV2Account(state: SparseMerkleState, address: Address): StateV2Account {
  const value = state.get(accountKey(address));
  if (value === undefined) return { balanceAtoms: 0, nonce: 0 };
  if (!value || typeof value !== "object" ||
      !Number.isSafeInteger((value as Partial<StateV2Account>).balanceAtoms) ||
      !Number.isSafeInteger((value as Partial<StateV2Account>).nonce)) {
    throw new Error("Corrupt protocol v2 account state");
  }
  const account = value as StateV2Account;
  if (account.balanceAtoms < 0 || account.balanceAtoms > MAX_SUPPLY_ATOMS || account.nonce < 0) {
    throw new Error("Corrupt protocol v2 account state");
  }
  return account;
}

function requireStateV2Nonce(state: SparseMerkleState, address: Address, nonce: number): void {
  if (nonce !== stateV2Account(state, address).nonce + 1) throw new Error("Invalid nonce");
}

function debitStateV2(state: SparseMerkleState, address: Address, amount: number): SparseMerkleState {
  const account = stateV2Account(state, address);
  if (account.balanceAtoms < amount) throw new Error("Insufficient balance");
  return state.set(accountKey(address), { balanceAtoms: account.balanceAtoms - amount, nonce: account.nonce });
}

function creditStateV2(state: SparseMerkleState, address: Address, amount: number): SparseMerkleState {
  const account = stateV2Account(state, address);
  const balanceAtoms = account.balanceAtoms + amount;
  if (!Number.isSafeInteger(balanceAtoms) || balanceAtoms > MAX_SUPPLY_ATOMS) throw new Error("Balance overflow");
  return state.set(accountKey(address), { balanceAtoms, nonce: account.nonce });
}

function setStateV2Nonce(state: SparseMerkleState, address: Address, nonce: number): SparseMerkleState {
  const account = stateV2Account(state, address);
  return state.set(accountKey(address), { balanceAtoms: account.balanceAtoms, nonce });
}

function accountKey(address: Address): string {
  return `account:${address}`;
}

function activityEpochKey(epoch: number): string {
  return `activity-epoch:${epoch}`;
}

function validatorScheduleKey(activationHeight: number): string {
  return `validator-schedule:${activationHeight}`;
}

function protocolScheduleKey(activationHeight: number): string {
  return `protocol-schedule:${activationHeight}`;
}

function updateNode(
  node: TreeNode | undefined,
  depth: number,
  keyBytes: Buffer,
  keyHash: string,
  valueHash: string,
  valueJson: string,
  created: StateV2NodeRecord[]
): TreeNode {
  if (!node) return recordCreated(leafNodeAtDepth(keyBytes, keyHash, valueHash, valueJson, depth), created);
  if (node.kind === "leaf") {
    if (node.keyHash === keyHash) {
      return recordCreated(leafNodeAtDepth(keyBytes, keyHash, valueHash, valueJson, depth), created);
    }
    if (depth === TREE_DEPTH) throw new Error("State v2 key hash collision");
    return mergeLeaves(node, keyBytes, keyHash, valueHash, valueJson, depth, created);
  }
  if (depth === TREE_DEPTH) throw new Error("Corrupt State v2 branch depth");
  const branch = node?.kind === "branch" ? node : undefined;
  let left = branch?.left;
  let right = branch?.right;
  if (bitAt(keyBytes, depth) === 0) {
    left = updateNode(left, depth + 1, keyBytes, keyHash, valueHash, valueJson, created);
  } else {
    right = updateNode(right, depth + 1, keyBytes, keyHash, valueHash, valueJson, created);
  }
  const hash = branchHash(left?.hash ?? EMPTY_HASHES[depth + 1]!, right?.hash ?? EMPTY_HASHES[depth + 1]!);
  return recordCreated({ kind: "branch", hash, left, right }, created);
}

function mergeLeaves(
  existing: LeafNode,
  incomingKeyBytes: Buffer,
  incomingKeyHash: string,
  incomingValueHash: string,
  incomingValueJson: string,
  depth: number,
  created: StateV2NodeRecord[]
): TreeNode {
  if (depth === TREE_DEPTH) throw new Error("State v2 key hash collision");
  const existingKeyBytes = Buffer.from(existing.keyHash, "hex");
  const existingBit = bitAt(existingKeyBytes, depth);
  const incomingBit = bitAt(incomingKeyBytes, depth);
  let left: TreeNode | undefined;
  let right: TreeNode | undefined;
  if (existingBit !== incomingBit) {
    const existingLeaf = recordCreated(
      leafNodeAtDepth(existingKeyBytes, existing.keyHash, existing.valueHash, existing.valueJson, depth + 1), created
    );
    const incomingLeaf = recordCreated(
      leafNodeAtDepth(incomingKeyBytes, incomingKeyHash, incomingValueHash, incomingValueJson, depth + 1), created
    );
    left = existingBit === 0 ? existingLeaf : incomingLeaf;
    right = existingBit === 1 ? existingLeaf : incomingLeaf;
  } else {
    const child = mergeLeaves(
      existing, incomingKeyBytes, incomingKeyHash, incomingValueHash, incomingValueJson, depth + 1, created
    );
    if (existingBit === 0) left = child;
    else right = child;
  }
  return recordCreated({
    kind: "branch",
    left,
    right,
    hash: branchHash(left?.hash ?? EMPTY_HASHES[depth + 1]!, right?.hash ?? EMPTY_HASHES[depth + 1]!)
  }, created);
}

function recordCreated<T extends TreeNode>(node: T, records: StateV2NodeRecord[]): T {
  if (node.kind === "leaf") {
    records.push({
      kind: "leaf", hash: node.hash, keyHash: node.keyHash,
      valueHash: node.valueHash, valueJson: node.valueJson
    });
  } else {
    records.push({
      kind: "branch", hash: node.hash,
      leftHash: node.left?.hash ?? null, rightHash: node.right?.hash ?? null
    });
  }
  return node;
}

function leafNodeAtDepth(keyBytes: Buffer, keyHash: string, valueHash: string, valueJson: string, depth: number): LeafNode {
  let hash = leafHash(keyHash, valueHash);
  for (let cursor = TREE_DEPTH - 1; cursor >= depth; cursor -= 1) {
    hash = bitAt(keyBytes, cursor) === 0
      ? branchHash(hash, EMPTY_HASHES[cursor + 1]!)
      : branchHash(EMPTY_HASHES[cursor + 1]!, hash);
  }
  return { kind: "leaf", keyHash, valueHash, valueJson, hash };
}

function appendCompressedLeafProof(
  siblings: string[],
  leaf: LeafNode,
  requestedKeyBytes: Buffer,
  depth: number
): void {
  const leafKeyBytes = Buffer.from(leaf.keyHash, "hex");
  let divergence = -1;
  for (let cursor = depth; cursor < TREE_DEPTH; cursor += 1) {
    if (bitAt(leafKeyBytes, cursor) !== bitAt(requestedKeyBytes, cursor)) {
      divergence = cursor;
      break;
    }
  }
  for (let cursor = depth; cursor < TREE_DEPTH; cursor += 1) {
    if (cursor === divergence) {
      siblings.push(leafNodeAtDepth(leafKeyBytes, leaf.keyHash, leaf.valueHash, leaf.valueJson, cursor + 1).hash);
    } else {
      siblings.push(EMPTY_HASHES[cursor + 1]!);
    }
  }
}

function findLeafValueHash(node: TreeNode | undefined, keyBytes: Buffer, keyHash: string): string | null {
  return findLeaf(node, keyBytes, keyHash)?.valueHash ?? null;
}

function findLeaf(node: TreeNode | undefined, keyBytes: Buffer, keyHash: string): LeafNode | undefined {
  let current = node;
  for (let depth = 0; current && depth <= TREE_DEPTH; depth += 1) {
    if (current.kind === "leaf") return current.keyHash === keyHash ? current : undefined;
    if (depth === TREE_DEPTH) return undefined;
    current = bitAt(keyBytes, depth) === 0 ? current.left : current.right;
  }
  return undefined;
}

function buildEmptyHashes(): string[] {
  const hashes = new Array<string>(TREE_DEPTH + 1);
  hashes[TREE_DEPTH] = hashWithDomain(EMPTY_LEAF_DOMAIN);
  for (let depth = TREE_DEPTH - 1; depth >= 0; depth -= 1) {
    hashes[depth] = branchHash(hashes[depth + 1]!, hashes[depth + 1]!);
  }
  return hashes;
}

function leafHash(keyHash: string, valueHash: string): string {
  return hashWithDomain(LEAF_DOMAIN, Buffer.from(keyHash, "hex"), Buffer.from(valueHash, "hex"));
}

function branchHash(left: string, right: string): string {
  return hashWithDomain(BRANCH_DOMAIN, Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function hashWithDomain(domain: Buffer, ...parts: Buffer[]): string {
  const hash = createHash("sha256");
  hash.update(domain);
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
}

function bitAt(bytes: Buffer, depth: number): 0 | 1 {
  const byte = bytes[Math.floor(depth / 8)]!;
  return ((byte >> (7 - (depth % 8))) & 1) as 0 | 1;
}
