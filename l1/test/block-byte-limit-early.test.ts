import assert from "node:assert/strict";
import test from "node:test";

import { MAX_BLOCK_BYTES, validateBlockEnvelope } from "../src/block.js";
import type { Block } from "../src/types.js";

const HEX32 = "11".repeat(32);

function previousBlock(): Block {
  return {
    header: {
      version: 1,
      chainId: "zyron-test",
      height: 0,
      round: 0,
      previousHash: "0".repeat(64),
      timestampMs: 1,
      transactionRoot: HEX32,
      stateRoot: HEX32,
      proposer: "GENESIS"
    },
    transactions: [],
    hash: HEX32,
    proposerPublicKey: null,
    signature: null,
    roundCertificate: [],
    attestations: []
  };
}

test("oversized count-valid block fails before envelope semantics and crypto", () => {
  const block: Block = {
    header: {
      version: 1,
      chainId: "x".repeat(MAX_BLOCK_BYTES + 1),
      height: 1,
      round: 0,
      previousHash: HEX32,
      timestampMs: 2,
      transactionRoot: HEX32,
      stateRoot: HEX32,
      proposer: "GENESIS"
    },
    transactions: [],
    hash: HEX32,
    proposerPublicKey: null,
    signature: null,
    roundCertificate: [],
    attestations: []
  };

  assert.throws(
    () => validateBlockEnvelope(block, previousBlock(), [], 2, false),
    /Block exceeds byte limit/
  );
});
