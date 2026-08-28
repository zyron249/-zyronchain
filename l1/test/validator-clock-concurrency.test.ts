import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  BLOCK_INTERVAL_MS,
  MAX_CONSENSUS_ROUND_CATCHUP,
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
const genesisTimestamp = 1_700_000_000_000;
const proposalNowMs = genesisTimestamp + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS;

function genesis(chainId: string): GenesisConfig {
  return {
    chainId,
    timestampMs: genesisTimestamp,
    validators: [{ address: validatorAddress, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

test("production block signing refreshes local clock after concurrent signing advances the watermark", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-fresh-signer-clock-"));
  const originalDateNow = Date.now;
  try {
    const service = new NodeService(
      await ChainStore.open(genesis("zyron-fresh-signer-clock-1"), dir),
      await SigningJournal.open(dir),
      validatorPrivate
    );
    let currentNowMs = proposalNowMs;
    Date.now = () => currentNowMs;
    let concurrentAdvanceObserved = false;

    const peers = {
      requestAttestations: async () => [],
      requestRoundSkips: async (height: number, round: number, previousCertificate = []) => {
        if (!concurrentAdvanceObserved && round === 0) {
          concurrentAdvanceObserved = true;
          currentNowMs = proposalNowMs + 2_001;
          try {
            await service.requestSkipVote(height, round, previousCertificate);
          } catch {
          }
        }
        return [];
      },
      broadcastBlock: async () => {}
    };

    const block = await produceFinalizedBlock(service, peers, validatorPrivate);
    assert.ok(block);
    assert.equal(concurrentAdvanceObserved, true);
    assert.equal(block.header.timestampMs, proposalNowMs, "consensus timestamp must stay anchored to the original round decision");
    assert.equal(service.status().height, 1);
    assert.deepEqual(service.readiness(), { ready: true, height: 1, reasons: [] });
  } finally {
    Date.now = originalDateNow;
    await rm(dir, { recursive: true, force: true });
  }
});

test("excessive forward round catch-up fails closed before peer consensus work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-round-catchup-bound-"));
  try {
    const service = new NodeService(
      await ChainStore.open(genesis("zyron-round-catchup-bound-1"), dir),
      await SigningJournal.open(dir),
      validatorPrivate
    );
    let skipRequests = 0;
    let attestationRequests = 0;
    let broadcasts = 0;
    const peers = {
      requestAttestations: async () => {
        attestationRequests += 1;
        return [];
      },
      requestRoundSkips: async () => {
        skipRequests += 1;
        return [];
      },
      broadcastBlock: async () => {
        broadcasts += 1;
      }
    };
    const tooFarNowMs = genesisTimestamp + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS * (MAX_CONSENSUS_ROUND_CATCHUP + 1);
    const block = await produceFinalizedBlock(service, peers, validatorPrivate, tooFarNowMs);
    assert.equal(block, null);
    assert.equal(skipRequests, 0);
    assert.equal(attestationRequests, 0);
    assert.equal(broadcasts, 0);
    assert.equal(service.status().height, 0);
    assert.deepEqual(service.readiness(), { ready: true, height: 0, reasons: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("real signer-clock rollback beyond one second still fails closed until restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-real-clock-rollback-"));
  try {
    const service = new NodeService(
      await ChainStore.open(genesis("zyron-real-clock-rollback-1"), dir),
      await SigningJournal.open(dir),
      validatorPrivate
    );
    await service.requestSkipVote(1, 0, [], proposalNowMs + 2_001);
    await assert.rejects(
      service.requestSkipVote(1, 0, [], proposalNowMs),
      /Validator clock moved backwards beyond the safety tolerance/
    );
    assert.deepEqual(service.readiness(), {
      ready: false,
      height: 0,
      reasons: ["validator-clock-unhealthy"]
    });
    await assert.rejects(
      service.requestSkipVote(1, 0, [], proposalNowMs + 3_000),
      /Validator clock fault requires process restart/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
