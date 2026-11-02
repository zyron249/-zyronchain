// Whole-chain linkage check run on a snapshot history right before sealing.
// Shared by the gateway and the snapshot build worker.
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { blockHash } = await import(join(l1Root, "dist/src", "block.js"));
const { merkleRoot } = await import(join(l1Root, "dist/src", "merkle.js"));

// One block of a snapshot history: right height and chain, links to
// `previous`, hash matches its header, transactions match the header's root
// and no transaction repeats. Returns the block hash (the next `previous`).
export function verifySnapshotBlock(block, { height, previous, chainId }) {
  const header = block?.header;
  assert.ok(header && typeof header === "object" && header.height === height && header.chainId === chainId, `snapshot block ${height} has the wrong height or chain ID`);
  assert.equal(header.previousHash, previous, `snapshot block ${height} does not link to block ${height - 1}`);
  assert.equal(blockHash(header), block.hash, `snapshot block ${height} hash does not match its header`);
  assert.ok(Array.isArray(block.transactions) && merkleRoot(block.transactions) === header.transactionRoot, `snapshot block ${height} transactions do not match its header`);
  assert.equal(new Set(block.transactions.map((tx) => tx?.txid)).size, block.transactions.length, `snapshot block ${height} repeats a transaction`);
  return block.hash;
}

export function verifySnapshotBlocks(blocks, { tip, tipHash, chainId, genesisHash }) {
  assert.ok(Array.isArray(blocks) && blocks.length === tip, `snapshot history has ${Array.isArray(blocks) ? blocks.length : "no"} blocks, expected ${tip}`);
  let previous = genesisHash;
  for (const [index, block] of blocks.entries()) previous = verifySnapshotBlock(block, { height: index + 1, previous, chainId });
  assert.equal(previous, tipHash, "snapshot history does not end at the live tip");
}
