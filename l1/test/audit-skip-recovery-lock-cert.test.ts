import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createPrepareVote } from "../src/round-view-change.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { NodeService } from "../src/node.js";
import type { GenesisConfig } from "../src/types.js";

const validatorOnePrivate = "01".padStart(64, "0");
const validatorTwoPrivate = "02".padStart(64, "0");
const oraclePrivate = "04".padStart(64, "0");
const validatorOnePublic = publicKeyFromPrivate(validatorOnePrivate);
const validatorTwoPublic = publicKeyFromPrivate(validatorTwoPrivate);
const validatorOne = addressFromPublicKey(validatorOnePublic);
const validatorTwo = addressFromPublicKey(validatorTwoPublic);
const activityPool = addressFromPublicKey(publicKeyFromPrivate("06".padStart(64, "0")));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-audit-lock-cert",
    timestampMs: 1_700_000_000_000,
    validators: [
      { address: validatorOne, publicKey: validatorOnePublic },
      { address: validatorTwo, publicKey: validatorTwoPublic }
    ],
    activityOracles: [publicKeyFromPrivate(oraclePrivate)],
    activityPool,
    allocations: [
      { address: validatorOne, amountAtoms: 1_000_000_000 },
      { address: activityPool, amountAtoms: 5_000_000_000 }
    ]
  };
}

test("AUDIT: skip-then-attest recovery must persist the prepare lock certificate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-audit-lock-"));
  try {
    const service = new NodeService(
      await ChainStore.open(genesis(), directory),
      await SigningJournal.open(directory),
      validatorOnePrivate
    );
    const blockTime = genesis().timestampMs + 30_000;
    const skipTime = blockTime + 60_000;

    const signed = await (async () => {
      const proposerDir = await mkdtemp(join(tmpdir(), "zyron-audit-prop-"));
      try {
        const proposer = new NodeService(
          await ChainStore.open(genesis(), proposerDir),
          await SigningJournal.open(proposerDir),
          validatorOnePrivate
        );
        const prepared = proposer.store.chain.prepareBlock([], validatorOnePublic, { timestampMs: blockTime });
        return await proposer.signPreparedProposal(prepared, blockTime);
      } finally {
        await rm(proposerDir, { recursive: true, force: true });
      }
    })();

    await service.requestSkipVote(1, 0, [], skipTime);

    const prepares = [
      createPrepareVote({
        chainId: genesis().chainId,
        height: 1,
        round: 0,
        blockHash: signed.hash,
        validatorPrivateKey: validatorOnePrivate,
        validatorPublicKey: validatorOnePublic
      }),
      createPrepareVote({
        chainId: genesis().chainId,
        height: 1,
        round: 0,
        blockHash: signed.hash,
        validatorPrivateKey: validatorTwoPrivate,
        validatorPublicKey: validatorTwoPublic
      })
    ];

    await service.attestProposal(signed, skipTime, prepares);

    const lockDir = join(directory, "lock-certificates");
    let files: string[] = [];
    try {
      files = await readdir(lockDir);
    } catch {
      files = [];
    }
    assert.ok(
      files.some((name) => name === "1-0.json"),
      `expected lock certificate 1-0.json after skip-then-attest recovery, found: ${files.join(",") || "(none)"}`
    );

    // Round-0 view-change needs no predecessor certificate; empty knownPrepares
    // forces the node to reload the durable lock certificate written on recovery.
    const vote = await service.requestViewChange(1, 0, [], [], skipTime);
    assert.equal(vote.lockRound, 0);
    assert.equal(vote.lockHash, signed.hash);
    assert.ok(vote.prepares.length >= 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
