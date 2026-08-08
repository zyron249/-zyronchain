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

  root(): string {
    return this.rootNode?.hash ?? EMPTY_HASHES[0]!;
  }

  set(key: string, value: unknown): SparseMerkleState {
    if (!key.length) throw new Error("State v2 key must not be empty");
    const keyHash = hashWithDomain(KEY_DOMAIN, Buffer.from(key, "utf8"));
    const valueHash = hashWithDomain(VALUE_DOMAIN, Buffer.from(canonicalJson(value), "utf8"));
    const keyBytes = Buffer.from(keyHash, "hex");
    return new SparseMerkleState(updateNode(this.rootNode, 0, keyBytes, keyHash, valueHash));
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
  valueHash: string
): TreeNode {
  if (!node) return leafNodeAtDepth(keyBytes, keyHash, valueHash, depth);
  if (node.kind === "leaf") {
    if (node.keyHash === keyHash) return leafNodeAtDepth(keyBytes, keyHash, valueHash, depth);
    if (depth === TREE_DEPTH) throw new Error("State v2 key hash collision");
    return mergeLeaves(node, keyBytes, keyHash, valueHash, depth);
  }
  if (depth === TREE_DEPTH) throw new Error("Corrupt State v2 branch depth");
  const branch = node?.kind === "branch" ? node : undefined;
  let left = branch?.left;
  let right = branch?.right;
  if (bitAt(keyBytes, depth) === 0) {
    left = updateNode(left, depth + 1, keyBytes, keyHash, valueHash);
  } else {
    right = updateNode(right, depth + 1, keyBytes, keyHash, valueHash);
  }
  const hash = branchHash(left?.hash ?? EMPTY_HASHES[depth + 1]!, right?.hash ?? EMPTY_HASHES[depth + 1]!);
  return { kind: "branch", hash, left, right };
}

function mergeLeaves(
  existing: LeafNode,
  incomingKeyBytes: Buffer,
  incomingKeyHash: string,
  incomingValueHash: string,
  depth: number
): TreeNode {
  if (depth === TREE_DEPTH) throw new Error("State v2 key hash collision");
  const existingKeyBytes = Buffer.from(existing.keyHash, "hex");
  const existingBit = bitAt(existingKeyBytes, depth);
  const incomingBit = bitAt(incomingKeyBytes, depth);
  let left: TreeNode | undefined;
  let right: TreeNode | undefined;
  if (existingBit !== incomingBit) {
    const existingLeaf = leafNodeAtDepth(existingKeyBytes, existing.keyHash, existing.valueHash, depth + 1);
    const incomingLeaf = leafNodeAtDepth(incomingKeyBytes, incomingKeyHash, incomingValueHash, depth + 1);
    left = existingBit === 0 ? existingLeaf : incomingLeaf;
    right = existingBit === 1 ? existingLeaf : incomingLeaf;
  } else {
    const child = mergeLeaves(existing, incomingKeyBytes, incomingKeyHash, incomingValueHash, depth + 1);
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

function leafNodeAtDepth(keyBytes: Buffer, keyHash: string, valueHash: string, depth: number): LeafNode {
  let hash = leafHash(keyHash, valueHash);
  for (let cursor = TREE_DEPTH - 1; cursor >= depth; cursor -= 1) {
    hash = bitAt(keyBytes, cursor) === 0
      ? branchHash(hash, EMPTY_HASHES[cursor + 1]!)
      : branchHash(EMPTY_HASHES[cursor + 1]!, hash);
  }
  return { kind: "leaf", keyHash, valueHash, hash };
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
      siblings.push(leafNodeAtDepth(leafKeyBytes, leaf.keyHash, leaf.valueHash, cursor + 1).hash);
    } else {
      siblings.push(EMPTY_HASHES[cursor + 1]!);
    }
  }
}

function findLeafValueHash(node: TreeNode | undefined, keyBytes: Buffer, keyHash: string): string | null {
  let current = node;
  for (let depth = 0; current && depth <= TREE_DEPTH; depth += 1) {
    if (current.kind === "leaf") return current.keyHash === keyHash ? current.valueHash : null;
    if (depth === TREE_DEPTH) return null;
    current = bitAt(keyBytes, depth) === 0 ? current.left : current.right;
  }
  return null;
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
