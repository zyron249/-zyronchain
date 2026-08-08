import { createHash } from "node:crypto";

import { canonicalJson } from "./codec.js";

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
  private constructor(private readonly rootNode?: TreeNode) {}

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
    return new SparseMerkleState(updateNode(this.rootNode, 0, keyBytes, keyHash, valueHash, valueJson));
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

function updateNode(
  node: TreeNode | undefined,
  depth: number,
  keyBytes: Buffer,
  keyHash: string,
  valueHash: string,
  valueJson: string
): TreeNode {
  if (!node) return leafNodeAtDepth(keyBytes, keyHash, valueHash, valueJson, depth);
  if (node.kind === "leaf") {
    if (node.keyHash === keyHash) return leafNodeAtDepth(keyBytes, keyHash, valueHash, valueJson, depth);
    if (depth === TREE_DEPTH) throw new Error("State v2 key hash collision");
    return mergeLeaves(node, keyBytes, keyHash, valueHash, valueJson, depth);
  }
  if (depth === TREE_DEPTH) throw new Error("Corrupt State v2 branch depth");
  const branch = node?.kind === "branch" ? node : undefined;
  let left = branch?.left;
  let right = branch?.right;
  if (bitAt(keyBytes, depth) === 0) {
    left = updateNode(left, depth + 1, keyBytes, keyHash, valueHash, valueJson);
  } else {
    right = updateNode(right, depth + 1, keyBytes, keyHash, valueHash, valueJson);
  }
  const hash = branchHash(left?.hash ?? EMPTY_HASHES[depth + 1]!, right?.hash ?? EMPTY_HASHES[depth + 1]!);
  return { kind: "branch", hash, left, right };
}

function mergeLeaves(
  existing: LeafNode,
  incomingKeyBytes: Buffer,
  incomingKeyHash: string,
  incomingValueHash: string,
  incomingValueJson: string,
  depth: number
): TreeNode {
  if (depth === TREE_DEPTH) throw new Error("State v2 key hash collision");
  const existingKeyBytes = Buffer.from(existing.keyHash, "hex");
  const existingBit = bitAt(existingKeyBytes, depth);
  const incomingBit = bitAt(incomingKeyBytes, depth);
  let left: TreeNode | undefined;
  let right: TreeNode | undefined;
  if (existingBit !== incomingBit) {
    const existingLeaf = leafNodeAtDepth(existingKeyBytes, existing.keyHash, existing.valueHash, existing.valueJson, depth + 1);
    const incomingLeaf = leafNodeAtDepth(incomingKeyBytes, incomingKeyHash, incomingValueHash, incomingValueJson, depth + 1);
    left = existingBit === 0 ? existingLeaf : incomingLeaf;
    right = existingBit === 1 ? existingLeaf : incomingLeaf;
  } else {
    const child = mergeLeaves(existing, incomingKeyBytes, incomingKeyHash, incomingValueHash, incomingValueJson, depth + 1);
    if (existingBit === 0) left = child;
    else right = child;
  }
  return {
    kind: "branch",
    left,
    right,
    hash: branchHash(left?.hash ?? EMPTY_HASHES[depth + 1]!, right?.hash ?? EMPTY_HASHES[depth + 1]!)
  };
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
