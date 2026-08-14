import assert from "node:assert/strict";
import test from "node:test";

import { validateBlockShape } from "../src/block.js";
import { MAX_CANONICAL_JSON_DEPTH } from "../src/codec.js";

test("block shape rejects deeply nested pre-validation JSON at the canonical depth boundary", () => {
  let transaction: unknown = { unexpected: true };
  for (let index = 0; index < MAX_CANONICAL_JSON_DEPTH + 1; index += 1) transaction = [transaction];

  const candidate = {
    header: {
      version: 1,
      chainId: "depth-regression",
      height: 1,
      round: 0,
      previousHash: "00".repeat(32),
      timestampMs: 1,
      transactionRoot: "11".repeat(32),
      stateRoot: "22".repeat(32),
      proposer: "GENESIS"
    },
    transactions: [transaction],
    hash: "33".repeat(32),
    proposerPublicKey: null,
    signature: null,
    roundCertificate: [],
    attestations: []
  };

  assert.throws(() => validateBlockShape(candidate), /Canonical JSON nesting depth exceeded/);
});
