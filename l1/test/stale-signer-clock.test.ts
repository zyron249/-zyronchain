import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { BLOCK_INTERVAL_MS, NodeService, ROUND_WINDOW_MS, produceFinalizedBlock } from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";

const validatorPrivate = "01".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validatorAddress = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("02".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("03".padStart(64, "0")));

test("producer does not reuse stale proposal time as signer clock after asynchronous peer work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-stale-signer-clock-"));
  try {
    const proposalNowMs = Date.now() - 2_500;
    const genesisTimestamp = proposalNowMs - BLOCK_INTERVAL_MS - ROUND_WINDOW_MS;
    const concurrentSigningNowMs = proposalNowMs + 2_001;
    const genesis = {
      chainId: "zyron-stale-signer-clock-regression",
      timestampMs: genesisTimestamp,
      validators: [{ address: validatorAddress, publicKey: validatorPublic }],
      activityOracles: [oraclePublic],
      activityPool,
      allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
    };
    const service = new NodeService(
      await ChainStore.open(genesis, directory),
      await SigningJournal.open(directory),
      validatorPrivate
    );

    let concurrentAdvanceAttempted = false;
    const peers = {
      requestAttestations: async () => [],
      requestRoundSkips: async (height: number, round: number, previousCertificate = []) => {
        if (!concurrentAdvanceAttempted && round === 0) {
          concurrentAdvanceAttempted = true;
          try {
            await service.requestSkipVote(height, round, previousCertificate, concurrentSigningNowMs);
          } catch {
            // Duplicate journal reservation is acceptable. On the vulnerable producer,
            // this call still advances the signing-clock watermark before the proposer
            // resumes with its stale captured proposal time.
          }
        }
        return [];
      },
      broadcastBlock: async () => {}
    };

    const block = await produceFinalizedBlock(service, peers, validatorPrivate, proposalNowMs);

    assert.equal(concurrentAdvanceAttempted, true);
    assert.ok(block);
    assert.equal(block.header.height, 1);
    assert.equal(service.status().height, 1);
    assert.deepEqual(service.readiness(), { ready: true, height: 1, reasons: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
