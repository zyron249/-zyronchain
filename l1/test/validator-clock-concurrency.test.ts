import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  BLOCK_INTERVAL_MS,
  ROUND_WINDOW_MS,
  NodeService,
  produceFinalizedBlock
} from "../src/node.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "01".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validatorAddress = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("02".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("03".padStart(64, "0")));

function genesis(chainId: string, timestampMs: number): GenesisConfig {
  return {
    chainId,
    timestampMs,
    validators: [{ address: validatorAddress, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

test("producer refreshes signing clock after asynchronous peer work advances validator watermark", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-stale-producer-clock-"));
  const originalDateNow = Date.now;
  try {
    const consensusNowMs = 1_700_000_000_000;
    const config = genesis(
      "zyron-stale-producer-clock-1",
      consensusNowMs - BLOCK_INTERVAL_MS - ROUND_WINDOW_MS
    );
    const service = new NodeService(
      await ChainStore.open(config, dir),
      await SigningJournal.open(dir),
      validatorPrivate
    );

    let wallNowMs = consensusNowMs;
    Date.now = () => wallNowMs;
    let concurrentAdvanceObserved = false;

    const peers = {
      requestAttestations: async () => [],
      requestRoundSkips: async (height: number, round: number, previousCertificate = []) => {
        if (!concurrentAdvanceObserved && round === 0) {
          concurrentAdvanceObserved = true;
          wallNowMs = consensusNowMs + 2_001;
          try {
            await service.requestSkipVote(height, round, previousCertificate);
          } catch {
            // The producer may already have reserved this skip. The important effect
            // is that a legitimate concurrent signing call samples the newer wall clock.
          }
        }
        return [];
      },
      broadcastBlock: async () => {}
    };

    const block = await produceFinalizedBlock(service, peers, validatorPrivate);
    assert.ok(block, "producer did not finalize after the concurrent signing advance");
    assert.equal(concurrentAdvanceObserved, true);
    assert.equal(block.header.timestampMs, consensusNowMs, "block timestamp drifted during asynchronous signing work");
    assert.equal(service.status().height, 1);
    assert.deepEqual(service.readiness(), { ready: true, height: 1, reasons: [] });
  } finally {
    Date.now = originalDateNow;
    await rm(dir, { recursive: true, force: true });
  }
});

test("explicit real clock rollback beyond one second still fails closed until restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-real-clock-rollback-regression-"));
  try {
    const genesisTimestamp = 1_700_000_000_000;
    const config = genesis("zyron-real-clock-rollback-regression-1", genesisTimestamp);
    const service = new NodeService(
      await ChainStore.open(config, dir),
      await SigningJournal.open(dir),
      validatorPrivate
    );
    const deadline = genesisTimestamp + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS;
    await service.requestSkipVote(1, 0, [], deadline + 2_001);
    await assert.rejects(
      service.requestSkipVote(1, 0, [], deadline),
      /Validator clock moved backwards beyond the safety tolerance/
    );
    assert.deepEqual(service.readiness(), {
      ready: false,
      height: 0,
      reasons: ["validator-clock-unhealthy"]
    });
    await assert.rejects(
      service.requestSkipVote(1, 0, [], deadline + 3_000),
      /Validator clock fault requires process restart/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
