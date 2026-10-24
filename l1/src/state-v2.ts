import { createHash } from "node:crypto";

import { canonicalJson, compareCanonicalStrings } from "./codec.js";
import { FIXED_FEE_MISMATCH_MESSAGE, splitFixedFee, type FixedFeeApplication } from "./fee-policy.js";
import { addressFromPublicKey } from "./crypto.js";
import { assertMiningNotRetired, MINING_TRACKER_ADDRESS } from "./mining.js";
import {
  ACTIVITY_ORDER_MESSAGE,
  ACTIVITY_WINDOW_AMOUNT_ADDRESS,
  ACTIVITY_WINDOW_RESERVED_MESSAGE,
  ACTIVITY_WINDOW_TIME_ADDRESS,
  activityRollingWindowEnforced,
  activitySettlementCapAtoms,
  assertActivityRollingWindow,
  assertActivitySettlementWithinCap,
  assertNoActivityPoolDirectDebit,
  isActivityWindowAddress
} from "./activity.js";
import { assertActivitySettlementAuthorized, type ActivityOracleSet } from "./activity-oracle.js";
import { assertAllocationLockOutflow, type AllocationLockContext } from "./allocation-locks.js";
import { assertNoActivityPoolInflow, LedgerState, type LedgerSnapshot } from "./state.js";
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
  left: NodeLink | undefined;
  right: NodeLink | undefined;
}

type TreeNode = LeafNode | BranchNode;
interface NodeRef { kind: "ref"; hash: string }
type NodeLink = TreeNode | NodeRef;
export type StateV2NodeResolver = (hash: string) => StateV2NodeRecord | undefined;

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

export interface StateV2ReachabilityIndex {
  depth(hash: string): number | undefined;
  remember(hash: string, depth: number): void;
}

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
    private readonly rootNode?: NodeLink,
    private readonly pendingRecordHead?: PendingRecordChunk,
    private readonly nodeResolver?: StateV2NodeResolver
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
      // Hydration is synchronous and constructs independent TreeNode objects.
      // Holding the caller's immutable scalar fields here avoids a second deep
      // copy of every (potentially large) leaf value during checkpoint import.
      byHash.set(record.hash, record);
    }
    const state = SparseMerkleState.fromNodeResolver(rootHash, (hash) => byHash.get(hash));
    // Preserve the fail-closed constructor contract: every root-reachable record
    // is resolved and authenticated before imported bytes can become state.
    state.reachableNodeHashes();
    return state;
  }

  /** Build a hash-referenced state without eagerly materializing every child. */
  static fromNodeResolver(rootHash: string, resolver: StateV2NodeResolver): SparseMerkleState {
    if (!/^[0-9a-f]{64}$/.test(rootHash)) throw new Error("Invalid State v2 root hash");
    if (rootHash === EMPTY_HASHES[0]) return SparseMerkleState.empty();
    const state = new SparseMerkleState({ kind: "ref", hash: rootHash }, undefined, resolver);
    state.resolveNode(state.rootNode!, 0);
    return state;
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
    const rootNode = updateNode(this.rootNode, 0, keyBytes, keyHash, valueHash, valueJson, created,
      (link, depth) => this.resolveNode(link, depth));
    return new SparseMerkleState(rootNode, { records: created, previous: this.pendingRecordHead }, this.nodeResolver);
  }

  get(key: string): unknown | undefined {
    if (!key.length) throw new Error("State v2 key must not be empty");
    const keyHash = hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
    const leaf = findLeaf(this.rootNode, Buffer.from(keyHash, "hex"), keyHash,
      (link, depth) => this.resolveNode(link, depth));
    return leaf ? JSON.parse(leaf.valueJson) as unknown : undefined;
  }

  nodeRecords(): StateV2NodeRecord[] {
    const records: StateV2NodeRecord[] = [];
    for (const batch of this.nodeRecordBatches(4_096)) {
      for (const record of batch) records.push(record);
    }
    return records;
  }

  /**
   * The records of nodeRecords(), in the same order (children before their
   * branch), produced lazily in batches of at most `batchSize`. The traversal is
   * iterative and resumes where the previous batch stopped, so a caller can
   * yield to the event loop between batches of a large tree instead of building
   * the whole list in one synchronous step (Codex P2 on #1060). The state is
   * immutable, so interleaving other work between batches cannot change them.
   */
  *nodeRecordBatches(batchSize: number): Generator<StateV2NodeRecord[], void, undefined> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Invalid State v2 node record batch size");
    const seen = new Set<string>();
    const stack: Array<{ node: BranchNode; depth: number; next: 0 | 1 | 2 }> = [];
    let batch: StateV2NodeRecord[] = [];
    const enter = (link: NodeLink | undefined, depth: number): void => {
      if (!link || seen.has(link.hash)) return;
      const node = this.resolveNode(link, depth);
      seen.add(node.hash);
      if (node.kind === "leaf") {
        batch.push({
          kind: "leaf", hash: node.hash, keyHash: node.keyHash,
          valueHash: node.valueHash, valueJson: node.valueJson
        });
      } else {
        stack.push({ node, depth, next: 0 });
      }
    };
    enter(this.rootNode, 0);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.next === 0) {
        frame.next = 1;
        enter(frame.node.left, frame.depth + 1);
      } else if (frame.next === 1) {
        frame.next = 2;
        enter(frame.node.right, frame.depth + 1);
      } else {
        stack.pop();
        batch.push({
          kind: "branch", hash: frame.node.hash,
          leftHash: linkHash(frame.node.left) ?? null, rightHash: linkHash(frame.node.right) ?? null
        });
      }
      if (batch.length >= batchSize) {
        yield batch;
        batch = [];
      }
    }
    if (batch.length > 0) yield batch;
  }

  /** Reachability metadata without duplicating full leaf payloads. */
  reachableNodeHashes(): Set<string> {
    const hashes = new Set<string>();
    const depths = new Map<string, number>();
    this.validateReachable({
      depth: (hash) => depths.get(hash),
      remember: (hash, depth) => {
        depths.set(hash, depth);
        hashes.add(hash);
      }
    });
    return hashes;
  }

  /**
   * Authenticate the complete root-reachable graph using caller-owned visit
   * bookkeeping. Disk stores use a SQLite-backed index here so restart memory
   * stays bounded even when the committed state contains millions of nodes.
   */
  validateReachable(index: StateV2ReachabilityIndex, onLeaf?: (keyHash: string, nodeHash: string) => void): void {
    const visit = (link: NodeLink | undefined, depth: number): void => {
      if (!link) return;
      const previousDepth = index.depth(link.hash);
      if (previousDepth !== undefined && previousDepth !== depth) {
        throw new Error("State v2 node reused at inconsistent depth");
      }
      if (previousDepth !== undefined) return;
      index.remember(link.hash, depth);
      const node = this.resolveNode(link, depth);
      if (node.kind === "branch") {
        visit(node.left, depth + 1);
        visit(node.right, depth + 1);
      } else {
        onLeaf?.(node.keyHash, node.hash);
      }
    };
    visit(this.rootNode, 0);
  }

  /** Leaf-key commitment set without allocating full node-record snapshots. */
  leafKeyHashes(): Set<string> {
    const hashes = new Set<string>();
    const seenNodes = new Set<string>();
    const visit = (link: NodeLink | undefined, depth: number): void => {
      if (!link || seenNodes.has(link.hash)) return;
      const node = this.resolveNode(link, depth);
      seenNodes.add(node.hash);
      if (node.kind === "leaf") {
        hashes.add(node.keyHash);
        return;
      }
      visit(node.left, depth + 1);
      visit(node.right, depth + 1);
    };
    visit(this.rootNode, 0);
    return hashes;
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
    return new SparseMerkleState(this.rootNode, undefined, this.nodeResolver);
  }

  prove(key: string): SparseMerkleProof {
    if (!key.length) throw new Error("State v2 key must not be empty");
    const keyHash = hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
    const keyBytes = Buffer.from(keyHash, "hex");
    const siblings: string[] = [];
    let link = this.rootNode;
    for (let depth = 0; depth < TREE_DEPTH; depth += 1) {
      if (!link) {
        for (let rest = depth; rest < TREE_DEPTH; rest += 1) siblings.push(EMPTY_HASHES[rest + 1]!);
        break;
      }
      const node = this.resolveNode(link, depth);
      if (node.kind === "leaf") {
        appendCompressedLeafProof(siblings, node, keyBytes, depth);
        break;
      }
      const branch = node;
      if (bitAt(keyBytes, depth) === 0) {
        siblings.push(linkHash(branch?.right) ?? EMPTY_HASHES[depth + 1]!);
        link = branch?.left;
      } else {
        siblings.push(linkHash(branch?.left) ?? EMPTY_HASHES[depth + 1]!);
        link = branch?.right;
      }
    }
    const valueHash = findLeafValueHash(this.rootNode, keyBytes, keyHash,
      (nodeLink, depth) => this.resolveNode(nodeLink, depth));
    return { version: 1, keyHash, valueHash, siblings };
  }

  private resolveNode(link: NodeLink, depth: number): TreeNode {
    if (link.kind !== "ref") return link;
    const record = this.nodeResolver?.(link.hash);
    if (!record) throw new Error("Missing State v2 node record");
    if (record.hash !== link.hash) throw new Error("State v2 resolver returned wrong node hash");
    return nodeFromRecord(record, depth);
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
  /** Present only after a pause, resume or revoke. Omitted when empty so older views stay canonical. */
  activityOracleGovernance?: Array<{
    activationHeight: number;
    action: "pause" | "resume" | "revoke";
    publicKeys: string[];
  }>;
}

export interface StateV2PortableView {
  ledger: LedgerSnapshot;
  governance: StateV2GovernanceSnapshot;
}

/**
 * Builds the semantic-key preimage list needed to reconstruct a portable State-v2
 * snapshot. The preimages are not trusted metadata: each is committed through its
 * domain-separated key hash in the existing sparse Merkle root.
 */
export function stateV2KeyPreimages(
  snapshot: LedgerSnapshot,
  governance: StateV2GovernanceSnapshot
): string[] {
  return [
    ...snapshot.accounts.map((account) => accountKey(account.address)),
    ...snapshot.settledActivityEpochs.map(activityEpochKey),
    ...governance.validatorSchedule.map((entry) => validatorScheduleKey(entry.activationHeight)),
    ...governance.protocolSchedule.map((entry) => protocolScheduleKey(entry.activationHeight)),
    ...(governance.activityOracleGovernance ?? []).map((entry) => activityOracleGovernanceKey(entry.activationHeight))
  ].sort();
}

/** Semantic keys introduced or touched by one already-validated v2 transaction. */
export function stateV2TransactionKeyPreimages(tx: Transaction): string[] {
  const keys = new Set<string>([accountKey(tx.sender)]);
  if (tx.kind === "transfer") {
    keys.add(accountKey(tx.receiver));
  } else if (tx.kind === "activity_settlement") {
    keys.add(activityEpochKey(tx.epoch));
    for (const entry of tx.entries) keys.add(accountKey(entry.receiver));
  } else if (tx.kind === "mining_claim") {
    keys.add(accountKey(MINING_TRACKER_ADDRESS));
  } else if (tx.kind === "validator_update") {
    keys.add(validatorScheduleKey(tx.activationHeight));
  } else if (tx.kind === "activity_oracle_governance") {
    keys.add(activityOracleGovernanceKey(tx.activationHeight));
  } else {
    keys.add(protocolScheduleKey(tx.activationHeight));
  }
  return [...keys].sort();
}

/**
 * Reconstructs the legacy/query ledger and governance schedule from authenticated
 * State-v2 records plus untrusted semantic-key preimages. Completeness is checked
 * against every reachable leaf and the reconstructed view must reproduce the exact
 * Merkle root, so a peer cannot omit or substitute a semantic key.
 */
export function reconstructStateV2PortableView(
  state: SparseMerkleState,
  keyPreimages: readonly string[]
): StateV2PortableView {
  const leafHashes = state.leafKeyHashes();
  if (keyPreimages.length !== leafHashes.size) throw new Error("State v2 key preimage count mismatch");

  const seenHashes = new Set<string>();
  const accounts: LedgerSnapshot["accounts"] = [];
  const epochs: number[] = [];
  const validatorSchedule: StateV2GovernanceSnapshot["validatorSchedule"] = [];
  const protocolSchedule: StateV2GovernanceSnapshot["protocolSchedule"] = [];
  const activityOracleGovernance: NonNullable<StateV2GovernanceSnapshot["activityOracleGovernance"]> = [];

  for (const key of keyPreimages) {
    if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new Error("Invalid State v2 key preimage");
    const keyHash = stateV2KeyHash(key);
    if (seenHashes.has(keyHash)) throw new Error("Duplicate State v2 key preimage");
    if (!leafHashes.has(keyHash)) throw new Error("State v2 key preimage is not committed by the root");
    seenHashes.add(keyHash);
    const value = state.get(key);
    if (value === undefined) throw new Error("State v2 key preimage has no committed value");

    if (key.startsWith("account:")) {
      const address = key.slice("account:".length) as Address;
      assertStateV2AccountValue(value);
      accounts.push({ address, balanceAtoms: Number(value.balanceAtoms), nonce: Number(value.nonce) });
    } else if (key.startsWith("activity-epoch:")) {
      const epoch = parseSemanticHeight(key.slice("activity-epoch:".length), "activity epoch");
      assertStateV2ActivityValue(value);
      epochs.push(epoch);
    } else if (key.startsWith("validator-schedule:")) {
      const activationHeight = parseSemanticHeight(key.slice("validator-schedule:".length), "validator activation height");
      assertStateV2ValidatorScheduleValue(value);
      validatorSchedule.push({ activationHeight, validators: structuredClone(value.validators) as Validator[] });
    } else if (key.startsWith("protocol-schedule:")) {
      const activationHeight = parseSemanticHeight(key.slice("protocol-schedule:".length), "protocol activation height");
      assertStateV2ProtocolScheduleValue(value);
      protocolSchedule.push({ activationHeight, protocolVersion: Number(value.protocolVersion) });
    } else if (key.startsWith("activity-oracle-governance:")) {
      const activationHeight = parseSemanticHeight(key.slice("activity-oracle-governance:".length), "activity oracle governance height");
      assertStateV2ActivityOracleGovernanceValue(value);
      activityOracleGovernance.push({
        activationHeight,
        action: value.action,
        publicKeys: [...value.publicKeys]
      });
    } else {
      throw new Error("Unknown State v2 semantic key");
    }
  }
  if (seenHashes.size !== leafHashes.size) throw new Error("Incomplete State v2 key preimage set");

  accounts.sort((a, b) => compareCanonicalStrings(a.address, b.address));
  epochs.sort((a, b) => a - b);
  validatorSchedule.sort((a, b) => a.activationHeight - b.activationHeight);
  protocolSchedule.sort((a, b) => a.activationHeight - b.activationHeight);
  activityOracleGovernance.sort((a, b) => a.activationHeight - b.activationHeight);
  assertUniqueSemanticNumbers(epochs, "activity epoch");
  assertUniqueSemanticNumbers(validatorSchedule.map((entry) => entry.activationHeight), "validator activation height");
  assertUniqueSemanticNumbers(protocolSchedule.map((entry) => entry.activationHeight), "protocol activation height");
  assertUniqueSemanticNumbers(activityOracleGovernance.map((entry) => entry.activationHeight), "activity oracle governance height");
  if (validatorSchedule[0]?.activationHeight !== 0 || protocolSchedule[0]?.activationHeight !== 0) {
    throw new Error("State v2 governance schedule must start at genesis");
  }

  const ledger = LedgerState.fromSnapshot({ accounts, settledActivityEpochs: epochs }).snapshot();
  const governance = {
    validatorSchedule,
    protocolSchedule,
    ...(activityOracleGovernance.length ? { activityOracleGovernance } : {})
  };
  if (stateV2FromLedgerSnapshot(ledger, governance).root() !== state.root()) {
    throw new Error("Reconstructed State v2 portable view root mismatch");
  }
  return { ledger, governance };
}

export function stateV2KeyHash(key: string): string {
  if (typeof key !== "string" || key.length < 1 || key.length > 256) throw new Error("Invalid State v2 key");
  return hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
}

export function stateV2FromLedgerSnapshot(
  snapshot: LedgerSnapshot,
  governance?: StateV2GovernanceSnapshot
): SparseMerkleState {
  const steps = stateV2FromLedgerSnapshotSteps(snapshot, governance);
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** Entries set per step of stateV2FromLedgerSnapshotSteps. */
export const STATE_V2_REBUILD_STEP_ENTRIES = 1_024;

/**
 * stateV2FromLedgerSnapshot in bounded steps: the generator yields after every
 * STATE_V2_REBUILD_STEP_ENTRIES entries and returns the same state. Each set()
 * hashes a key path, so rebuilding a large state is slow; a caller can yield to
 * the event loop between steps (Codex P2 on #1060).
 */
export function* stateV2FromLedgerSnapshotSteps(
  snapshot: LedgerSnapshot,
  governance?: StateV2GovernanceSnapshot
): Generator<void, SparseMerkleState, undefined> {
  let state = SparseMerkleState.empty();
  let entries = 0;
  const counted = function* (): Generator<void, void, undefined> {
    entries += 1;
    if (entries % STATE_V2_REBUILD_STEP_ENTRIES === 0) yield;
  };
  for (const account of [...snapshot.accounts].sort((a, b) => compareCanonicalStrings(a.address, b.address))) {
    state = state.set(accountKey(account.address), {
      balanceAtoms: account.balanceAtoms,
      nonce: account.nonce
    });
    yield* counted();
  }
  for (const epoch of [...snapshot.settledActivityEpochs].sort((a, b) => a - b)) {
    state = state.set(activityEpochKey(epoch), { settled: true });
    yield* counted();
  }
  if (governance) {
    for (const entry of [...governance.validatorSchedule].sort((a, b) => a.activationHeight - b.activationHeight)) {
      state = state.set(validatorScheduleKey(entry.activationHeight), { validators: entry.validators });
      yield* counted();
    }
    for (const entry of [...governance.protocolSchedule].sort((a, b) => a.activationHeight - b.activationHeight)) {
      state = state.set(protocolScheduleKey(entry.activationHeight), { protocolVersion: entry.protocolVersion });
      yield* counted();
    }
    for (const entry of [...(governance.activityOracleGovernance ?? [])].sort((a, b) => a.activationHeight - b.activationHeight)) {
      state = state.set(activityOracleGovernanceKey(entry.activationHeight), {
        action: entry.action,
        publicKeys: [...entry.publicKeys]
      });
      yield* counted();
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
  } else if (tx.kind === "mining_claim") {
    addresses.add(MINING_TRACKER_ADDRESS);
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

/**
 * Apply protocol-v2 ledger semantics directly to authenticated state.
 * `locks`: genesis allocation locks at the including block's timestamp (see
 * LedgerState.apply and allocation-locks.ts). `oracles`: genesis activity-oracle
 * keys and optional m-of-n threshold (see LedgerState.apply and activity-oracle.ts).
 */
export function applyStateV2Transaction(
  state: SparseMerkleState,
  tx: Transaction,
  activityPool: Address,
  locks?: AllocationLockContext,
  oracles?: ActivityOracleSet,
  fee?: FixedFeeApplication
): SparseMerkleState {
  const rollingWindow = activityRollingWindowEnforced(oracles);
  if (tx.kind === "transfer") {
    assertNoActivityPoolInflow(tx.receiver, activityPool);
    assertNoActivityPoolDirectDebit(tx.sender, activityPool, oracles);
    if (rollingWindow && isActivityWindowAddress(tx.receiver)) throw new Error(ACTIVITY_WINDOW_RESERVED_MESSAGE);
    // Same reservation and precedence as LedgerState.applyTransfer (defence in
    // depth; validateTransactionShape already rejects these on chain paths).
    if (tx.sender === MINING_TRACKER_ADDRESS || tx.receiver === MINING_TRACKER_ADDRESS) {
      throw new Error("Mining tracker address is protocol-reserved");
    }
    requireStateV2Nonce(state, tx.sender, tx.nonce);
    const total = tx.amountAtoms + tx.feeAtoms;
    if (!Number.isSafeInteger(total)) throw new Error("Insufficient balance");
    const senderBalance = stateV2Balance(state, tx.sender);
    if (senderBalance < total) throw new Error("Insufficient balance");
    assertAllocationLockOutflow(locks, tx.sender, senderBalance, total);
    let next = debitStateV2(state, tx.sender, total);
    next = creditStateV2(next, tx.receiver, tx.amountAtoms);
    if (fee) next = creditStateV2ProducerFee(next, tx.feeAtoms, fee, activityPool);
    return setStateV2Nonce(next, tx.sender, tx.nonce);
  }
  if (tx.kind === "activity_settlement") {
    if (oracles) {
      assertActivitySettlementAuthorized(tx, oracles, {
        chainId: tx.chainId,
        ...(locks?.blockTimestampMs !== undefined ? { blockTimestampMs: locks.blockTimestampMs } : {}),
        ...(oracles.timestampMs !== undefined ? { genesisTimestampMs: oracles.timestampMs } : {})
      });
    }
    if (tx.sender !== activityPool) throw new Error("Invalid activity pool sender");
    for (const entry of tx.entries) assertNoActivityPoolInflow(entry.receiver, activityPool);
    // Same reservation and precedence as LedgerState.applyActivity.
    if (tx.entries.some((entry) => entry.receiver === MINING_TRACKER_ADDRESS)) {
      throw new Error("Mining tracker address is protocol-reserved");
    }
    if (state.get(activityEpochKey(tx.epoch)) !== undefined) throw new Error("Activity epoch already settled");
    // Adjacent-order defence in depth (see LedgerState.applyActivity).
    if (state.get(activityEpochKey(tx.epoch + 1)) !== undefined) throw new Error(ACTIVITY_ORDER_MESSAGE);
    requireStateV2Nonce(state, activityPool, tx.nonce);
    const capAtoms = activitySettlementCapAtoms(oracles);
    const total = assertActivitySettlementWithinCap(tx.entries, capAtoms);
    if (rollingWindow) {
      // Rolling 24 h cap under fixed-supply-v1 (see activity.ts).
      if (tx.entries.some((entry) => isActivityWindowAddress(entry.receiver))) {
        throw new Error(ACTIVITY_WINDOW_RESERVED_MESSAGE);
      }
      assertActivityRollingWindow({
        timestampMs: stateV2Nonce(state, ACTIVITY_WINDOW_TIME_ADDRESS),
        amountAtoms: stateV2Nonce(state, ACTIVITY_WINDOW_AMOUNT_ADDRESS)
      }, locks?.blockTimestampMs, total, capAtoms);
    }
    const poolBalance = stateV2Balance(state, activityPool);
    if (poolBalance < total) throw new Error("Insufficient balance");
    assertAllocationLockOutflow(locks, activityPool, poolBalance, total);
    let next = debitStateV2(state, activityPool, total);
    for (const entry of tx.entries) next = creditStateV2(next, entry.receiver, entry.amountAtoms);
    next = setStateV2Nonce(next, activityPool, tx.nonce);
    if (rollingWindow) {
      next = setStateV2Nonce(next, ACTIVITY_WINDOW_TIME_ADDRESS, locks!.blockTimestampMs);
      next = setStateV2Nonce(next, ACTIVITY_WINDOW_AMOUNT_ADDRESS, total);
    }
    return next.set(activityEpochKey(tx.epoch), { settled: true });
  }
  if (tx.kind === "mining_claim") {
    assertMiningNotRetired();
    throw new Error("Mining claim requires chain-context State-v2 application");
  }
  // Same reservation as LedgerState.applyValidatorUpdate / applyProtocolUpgrade.
  if (tx.sender === MINING_TRACKER_ADDRESS) throw new Error("Mining tracker address is protocol-reserved");
  requireStateV2Nonce(state, tx.sender, tx.nonce);
  let next = setStateV2Nonce(state, tx.sender, tx.nonce);
  if (tx.kind === "validator_update") {
    next = next.set(validatorScheduleKey(tx.activationHeight), { validators: tx.validators });
  } else if (tx.kind === "activity_oracle_governance") {
    next = next.set(activityOracleGovernanceKey(tx.activationHeight), { action: tx.action, publicKeys: [...tx.publicKeys] });
  } else {
    next = next.set(protocolScheduleKey(tx.activationHeight), { protocolVersion: tx.protocolVersion });
  }
  return next;
}

interface StateV2Account {
  balanceAtoms: number;
  nonce: number;
}

export function stateV2Balance(state: SparseMerkleState, address: Address): number {
  return stateV2Account(state, address).balanceAtoms;
}

export function stateV2Nonce(state: SparseMerkleState, address: Address): number {
  return stateV2Account(state, address).nonce;
}

export function stateV2ActivityEpochSettled(state: SparseMerkleState, epoch: number): boolean {
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid activity epoch");
  const value = state.get(activityEpochKey(epoch));
  if (value === undefined) return false;
  assertExactPortableRecord(value, ["settled"], "State v2 activity value");
  if (value.settled !== true) throw new Error("Corrupt protocol v2 activity state");
  return true;
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

/** fixed-fee-v1 producer share. A zero share does not create an account. */
function creditStateV2ProducerFee(
  state: SparseMerkleState,
  feeAtoms: number,
  fee: FixedFeeApplication,
  activityPool: Address
): SparseMerkleState {
  if (feeAtoms !== fee.fixedTransferFeeAtoms) throw new Error(FIXED_FEE_MISMATCH_MESSAGE);
  const { producerAtoms } = splitFixedFee(feeAtoms);
  if (producerAtoms <= 0) return state;
  if (fee.producer === MINING_TRACKER_ADDRESS) throw new Error("Mining tracker address is protocol-reserved");
  assertNoActivityPoolInflow(fee.producer, activityPool);
  return creditStateV2(state, fee.producer, producerAtoms);
}

function setStateV2Nonce(state: SparseMerkleState, address: Address, nonce: number): SparseMerkleState {
  const account = stateV2Account(state, address);
  return state.set(accountKey(address), { balanceAtoms: account.balanceAtoms, nonce });
}

export function accountKey(address: Address): string {
  return `account:${address}`;
}

export function activityEpochKey(epoch: number): string {
  return `activity-epoch:${epoch}`;
}

export function validatorScheduleKey(activationHeight: number): string {
  return `validator-schedule:${activationHeight}`;
}

export function protocolScheduleKey(activationHeight: number): string {
  return `protocol-schedule:${activationHeight}`;
}

export function activityOracleGovernanceKey(activationHeight: number): string {
  return `activity-oracle-governance:${activationHeight}`;
}

/**
 * Untrusted-input pre-check for a portable key preimage (round-4 PR980): only
 * the semantic key families that {@link reconstructStateV2PortableView}
 * accepts, with canonical decimal heights. Run per state-sync chunk so an
 * unknown key rejects at the first chunk that carries it.
 */
// The value schema of each semantic key type. Shared by the final portable
// view reconstruction and the per-chunk state-sync check, so the two cannot
// drift apart.
function assertStateV2AccountValue(value: unknown): asserts value is { balanceAtoms: number; nonce: number } {
  assertExactPortableRecord(value, ["balanceAtoms", "nonce"], "State v2 account value");
  if (!Number.isSafeInteger(value.balanceAtoms) || Number(value.balanceAtoms) < 0 ||
      !Number.isSafeInteger(value.nonce) || Number(value.nonce) < 0) {
    throw new Error("Invalid State v2 account value");
  }
}

function assertStateV2ActivityValue(value: unknown): asserts value is { settled: true } {
  assertExactPortableRecord(value, ["settled"], "State v2 activity value");
  if (value.settled !== true) throw new Error("Invalid State v2 activity value");
}

function assertStateV2ValidatorScheduleValue(value: unknown): asserts value is { validators: unknown[] } {
  assertExactPortableRecord(value, ["validators"], "State v2 validator schedule value");
  if (!Array.isArray(value.validators)) throw new Error("Invalid State v2 validator schedule value");
}

function assertStateV2ActivityOracleGovernanceValue(value: unknown): asserts value is {
  action: "pause" | "resume" | "revoke";
  publicKeys: string[];
} {
  assertExactPortableRecord(value, ["action", "publicKeys"], "State v2 activity oracle governance value");
  if (value.action !== "pause" && value.action !== "resume" && value.action !== "revoke") {
    throw new Error("Invalid State v2 activity oracle governance value");
  }
  if (!Array.isArray(value.publicKeys) || value.publicKeys.length > 100) {
    throw new Error("Invalid State v2 activity oracle governance value");
  }
  const seen = new Set<string>();
  for (const publicKey of value.publicKeys) {
    if (typeof publicKey !== "string" || !/^[0-9a-f]{128}$/.test(publicKey) || seen.has(publicKey)) {
      throw new Error("Invalid State v2 activity oracle governance value");
    }
    seen.add(publicKey);
  }
  if ((value.action === "pause" || value.action === "resume") && value.publicKeys.length !== 0) {
    throw new Error("Invalid State v2 activity oracle governance value");
  }
  if (value.action === "revoke" && value.publicKeys.length === 0) {
    throw new Error("Invalid State v2 activity oracle governance value");
  }
}

function assertStateV2ProtocolScheduleValue(value: unknown): asserts value is { protocolVersion: number } {
  assertExactPortableRecord(value, ["protocolVersion"], "State v2 protocol schedule value");
  if (!Number.isSafeInteger(value.protocolVersion) || Number(value.protocolVersion) < 1) {
    throw new Error("Invalid State v2 protocol schedule value");
  }
}

/**
 * R5-998-M1: a leaf record does not carry its semantic key, so before the key
 * preimages arrive a state-sync client can only require that a leaf value is
 * valid for at least one semantic key type. The field sets of the types are
 * disjoint, so the exact field set selects the only candidate schema. The
 * binding of each value to its own key type is still checked by
 * reconstructStateV2PortableView during the final anchored assembly.
 */
export function assertStateV2LeafValueSchema(value: unknown): void {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    const fields = Object.keys(value).sort().join(",");
    if (fields === "balanceAtoms,nonce") assertStateV2AccountValue(value);
    else if (fields === "settled") assertStateV2ActivityValue(value);
    else if (fields === "validators") {
      assertStateV2ValidatorScheduleValue(value);
      assertPortableValidatorList(value.validators);
    }     else if (fields === "protocolVersion") {
      assertStateV2ProtocolScheduleValue(value);
      if (value.protocolVersion > MAX_PORTABLE_PROTOCOL_VERSION) throw new Error("protocol version out of range");
    } else if (fields === "action,publicKeys") {
      assertStateV2ActivityOracleGovernanceValue(value);
    } else throw new Error("unknown field set");
  } catch (cause) {
    throw new Error("Invalid portable State v2 leaf value schema", { cause });
  }
}

// Codex review of #1010: the per-chunk check also applies the bounds that
// checkpoint validation (chain.ts validateValidatorSchedule /
// validateProtocolSchedule) requires of every schedule entry, so such a leaf
// is rejected in its chunk too. The curve check of each public key stays with
// checkpoint validation (the address derivation already binds the key).
const MAX_PORTABLE_PROTOCOL_VERSION = 65_535;
const MAX_PORTABLE_SCHEDULE_VALIDATORS = 100;

function assertPortableValidatorList(validators: unknown[]): void {
  if (validators.length < 1 || validators.length > MAX_PORTABLE_SCHEDULE_VALIDATORS) throw new Error("validator count out of range");
  const seen = new Set<string>();
  for (const item of validators) {
    assertExactPortableRecord(item, ["address", "publicKey"], "State v2 validator");
    if (typeof item.address !== "string" || !/^ZYN[0-9a-f]{40}$/.test(item.address) ||
        typeof item.publicKey !== "string" || !/^[0-9a-f]{128}$/.test(item.publicKey) ||
        addressFromPublicKey(item.publicKey) !== item.address || seen.has(item.address)) {
      throw new Error("Invalid State v2 validator");
    }
    seen.add(item.address);
  }
}

export function assertStateV2SemanticKeyShape(key: string): void {
  if (key.startsWith("account:")) {
    if (key.length === "account:".length) throw new Error("Invalid State v2 account key");
    return;
  }
  if (key.startsWith("activity-epoch:")) { parseSemanticHeight(key.slice("activity-epoch:".length), "activity epoch"); return; }
  if (key.startsWith("validator-schedule:")) {
    parseSemanticHeight(key.slice("validator-schedule:".length), "validator activation height");
    return;
  }
  if (key.startsWith("protocol-schedule:")) {
    parseSemanticHeight(key.slice("protocol-schedule:".length), "protocol activation height");
    return;
  }
  if (key.startsWith("activity-oracle-governance:")) {
    parseSemanticHeight(key.slice("activity-oracle-governance:".length), "activity oracle governance height");
    return;
  }
  throw new Error("Unknown State v2 semantic key");
}

function parseSemanticHeight(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid State v2 ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid State v2 ${name}`);
  return parsed;
}

function assertUniqueSemanticNumbers(values: readonly number[], name: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) throw new Error(`Duplicate State v2 ${name}`);
  }
}

function assertExactPortableRecord(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${name} fields`);
  }
}

function updateNode(
  link: NodeLink | undefined,
  depth: number,
  keyBytes: Buffer,
  keyHash: string,
  valueHash: string,
  valueJson: string,
  created: StateV2NodeRecord[],
  resolve: (link: NodeLink, depth: number) => TreeNode
): TreeNode {
  const node = link ? resolve(link, depth) : undefined;
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
    left = updateNode(left, depth + 1, keyBytes, keyHash, valueHash, valueJson, created, resolve);
  } else {
    right = updateNode(right, depth + 1, keyBytes, keyHash, valueHash, valueJson, created, resolve);
  }
  const hash = branchHash(linkHash(left) ?? EMPTY_HASHES[depth + 1]!, linkHash(right) ?? EMPTY_HASHES[depth + 1]!);
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
      leftHash: linkHash(node.left) ?? null, rightHash: linkHash(node.right) ?? null
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

function findLeafValueHash(
  node: NodeLink | undefined,
  keyBytes: Buffer,
  keyHash: string,
  resolve: (link: NodeLink, depth: number) => TreeNode
): string | null {
  return findLeaf(node, keyBytes, keyHash, resolve)?.valueHash ?? null;
}

function findLeaf(
  node: NodeLink | undefined,
  keyBytes: Buffer,
  keyHash: string,
  resolve: (link: NodeLink, depth: number) => TreeNode
): LeafNode | undefined {
  let current = node;
  for (let depth = 0; current && depth <= TREE_DEPTH; depth += 1) {
    const resolved = resolve(current, depth);
    if (resolved.kind === "leaf") return resolved.keyHash === keyHash ? resolved : undefined;
    if (depth === TREE_DEPTH) return undefined;
    current = bitAt(keyBytes, depth) === 0 ? resolved.left : resolved.right;
  }
  return undefined;
}

function linkHash(link: NodeLink | undefined): string | undefined {
  return link?.hash;
}

function nodeFromRecord(record: StateV2NodeRecord, depth: number): TreeNode {
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
    const left = record.leftHash === null ? undefined : { kind: "ref" as const, hash: record.leftHash };
    const right = record.rightHash === null ? undefined : { kind: "ref" as const, hash: record.rightHash };
    node = {
      kind: "branch",
      left,
      right,
      hash: branchHash(linkHash(left) ?? EMPTY_HASHES[depth + 1]!, linkHash(right) ?? EMPTY_HASHES[depth + 1]!)
    };
  }
  if (node.hash !== record.hash) throw new Error("State v2 node hash mismatch");
  return node;
}

function buildEmptyHashes(): string[] {
  const hashes = new Array<string>(TREE_DEPTH + 1);
  hashes[TREE_DEPTH] = hashWithDomain(EMPTY_LEAF_DOMAIN);
  for (let depth = TREE_DEPTH - 1; depth >= 0; depth -= 1) {
    hashes[depth] = branchHash(hashes[depth + 1]!, hashes[depth + 1]!);
  }
  return hashes;
}

/**
 * Position-independent self-consistency of one portable node record, used to
 * reject untrusted state-sync chunks early (F-09(b)). A leaf must commit to
 * its own value; a branch with two children must hash to them. A leaf's node
 * hash (compressed to its depth) and a branch with an empty child depend on
 * tree position and are checked only by the final root-anchored validation.
 */
export function assertStateV2NodeRecordSelfConsistent(record: StateV2NodeRecord): void {
  if (record.kind === "leaf") {
    if (hashWithDomain(VALUE_DOMAIN, Buffer.from(record.valueJson, "utf8")) !== record.valueHash) {
      throw new Error("Portable State v2 leaf value hash mismatch");
    }
    return;
  }
  if (record.leftHash !== null && record.rightHash !== null && branchHash(record.leftHash, record.rightHash) !== record.hash) {
    throw new Error("Portable State v2 branch hash mismatch");
  }
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

/**
 * R6-1010-M1: root-anchored, incremental check of untrusted state-sync node
 * records. The portable record list is a post-order walk (children before
 * their parent, the root last), so a client that reads it from the end sees
 * every record after its parent. Starting from the anchored state root at
 * depth 0, each record must be a child some already-accepted branch still
 * expects; it is then fully re-hashed at that depth (a leaf compressed to its
 * position, a branch with empty-subtree hashes for missing children) and must
 * reproduce the expected hash. A record that is not part of the anchored tree,
 * whatever hashes the peer recomputed around it, is therefore rejected in the
 * chunk that carries it.
 * R6b-1014-M1: records must also arrive in exact reverse post-order (a node,
 * then its right subtree, then its left subtree), which is the only order an
 * honest peer serves. The expected hashes form a stack: accepting a branch
 * pushes its left child and then its right child, and the next record must be
 * the top of the stack. A peer that reorders genuine records (for example
 * breadth first) is rejected at the first record out of order, and the stack
 * holds at most one pending left sibling per tree level plus the current
 * children, so it never grows beyond the tree depth. The final anchored
 * assembly still runs on the complete bundle.
 */
export class StateV2AnchoredRecordStream {
  private readonly expected: Array<{ hash: string; depth: number }> = [];
  private accepted = 0;
  // P1-08: key hashes of the accepted (anchored) leaves. They authenticate the
  // key-preimage count and every key preimage once the tree is complete.
  private readonly leafKeyHashes = new Set<string>();
  private finished = false;

  constructor(root: string) {
    if (!/^[0-9a-f]{64}$/.test(root)) throw new Error("Invalid State v2 root");
    this.expected.push({ hash: root, depth: 0 });
  }

  /** Accept the next record in reverse post-order (root first). */
  accept(record: StateV2NodeRecord): void {
    try {
      const next = this.expected.pop();
      if (next === undefined) throw new Error("record is not part of the anchored tree");
      if (record.hash !== next.hash) throw new Error("record is not the next node of the anchored tree in reverse post-order");
      const node = nodeFromRecord(record, next.depth);
      if (node.kind === "branch") {
        if (node.left === undefined && node.right === undefined) throw new Error("empty branch");
        if (node.left && node.right && node.left.hash === node.right.hash) throw new Error("duplicate child hash");
        if (node.left) this.expected.push({ hash: node.left.hash, depth: next.depth + 1 });
        if (node.right) this.expected.push({ hash: node.right.hash, depth: next.depth + 1 });
      } else if (record.kind === "leaf") {
        if (this.leafKeyHashes.has(record.keyHash)) throw new Error("duplicate leaf key hash");
        this.leafKeyHashes.add(record.keyHash);
      }
      this.accepted += 1;
    } catch (cause) {
      throw new Error("Portable State v2 record does not match the anchored state root", { cause });
    }
  }

  /** Hashes still expected (used by tests to check the depth bound). */
  outstandingCount(): number {
    return this.expected.length;
  }

  /** Every expected record arrived and no other one did. */
  finish(total: number): void {
    if (this.expected.length !== 0 || this.accepted !== total) {
      throw new Error("Portable State v2 record does not match the anchored state root", {
        cause: new Error("records missing from the anchored tree")
      });
    }
    this.finished = true;
  }

  /**
   * P1-08 (F-09(b) residual): once every anchored record arrived, the leaves
   * fix the exact key-preimage set. The returned stream checks each untrusted
   * key preimage against it as it arrives, so the peer-supplied key count and
   * every key preimage are authenticated by the anchored state root rather than
   * only by the final assembly. Call at most once, after finish().
   */
  keyPreimageStream(): StateV2AnchoredKeyPreimageStream {
    if (!this.finished) throw new Error("Anchored State v2 records are incomplete");
    this.finished = false;
    return new StateV2AnchoredKeyPreimageStream(this.leafKeyHashes);
  }
}

/**
 * P1-08: authenticated key-preimage check for state sync. `total` is the number
 * of anchored leaves, the only key-preimage count an honest peer can serve.
 * Each accepted preimage must hash to a still-unclaimed anchored leaf key, so
 * uncommitted and duplicate preimages are rejected in the chunk that carries
 * them. The set is consumed as preimages arrive, so memory does not grow.
 */
export class StateV2AnchoredKeyPreimageStream {
  readonly total: number;
  private accepted = 0;

  constructor(private readonly remaining: Set<string>) {
    this.total = remaining.size;
  }

  accept(key: string): void {
    if (!this.remaining.delete(stateV2KeyHash(key))) {
      throw new Error("State v2 key preimage is not committed by the anchored state root (or is a duplicate)");
    }
    this.accepted += 1;
  }

  /** Every anchored leaf has exactly one preimage. */
  finish(): void {
    if (this.remaining.size !== 0 || this.accepted !== this.total) {
      throw new Error("State v2 key preimages missing for anchored leaves");
    }
  }
}
