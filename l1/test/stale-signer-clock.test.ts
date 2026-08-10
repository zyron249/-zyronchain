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
const genesisTimestamp = 1_700_000_000_000;

function genesis() {
  return {
    chainId: "zyron-stale-signer-clock-regression",
    timestampMs: genesisTimestamp,
    validators: [{ address: validatorAddress, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

test("fresh signer clock prevents stale proposal time from false-faulting after peer await", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-stale-signer-clock-"));
  try {
    const service = new NodeService(
      await ChainStore.open(genesis(), directory),
      await SigningJournal.open(directory),
      validatorPrivate
    );
    const proposalNowMs = genesisTimestamp + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS;
    const concurrentSigningNowMs = proposalNowMs + 2_001;
    const freshSigningTimes = [
      proposalNowMs,
      concurrentSigningNowMs + 500,
      concurrentSigningNowMs + 501
    ];
    let signingIndex = 0;
    let concurrentAdvanceObserved = false;
    const peers = {
      requestAttestations: async () => [],
      requestRoundSkips: async (height: number, round: number, previousCertificate = []) => {
        if (!concurrentAdvanceObserved && round === 0) {
          concurrentAdvanceObserved = true;
          try {
            await service.requestSkipVote(height, round, previousCertificate, concurrentSigningNowMs);
          } catch {
            // The duplicate reservation is expected; the clock watermark advance is the condition under test.
          }
        }
        return [];
      },
      broadcastBlock: async () => {}
    };

    const block = await produceFinalizedBlock(
      service,
      peers,
      validatorPrivate,
      proposalNowMs,
      () => freshSigningTimes[signingIndex++] ?? concurrentSigningNowMs + 1_000
    );

    assert.equal(concurrentAdvanceObserved, true);
    assert.ok(block);
    assert.equal(block.header.height, 1);
    assert.equal(service.status().height, 1);
    assert.deepEqual(service.readiness(), { ready: true, height: 1, reasons: [] });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
