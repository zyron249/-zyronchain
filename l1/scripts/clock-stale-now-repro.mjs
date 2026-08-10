#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { BLOCK_INTERVAL_MS, NodeService, ROUND_WINDOW_MS, produceFinalizedBlock } from "../dist/src/node.js";
import { ChainStore, SigningJournal } from "../dist/src/storage.js";

const validatorPrivate = "01".padStart(64, "0");
const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const validatorAddress = addressFromPublicKey(validatorPublic);
const oraclePublic = publicKeyFromPrivate("02".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("03".padStart(64, "0")));
const genesisTimestamp = 1_700_000_000_000;
const proposalNowMs = genesisTimestamp + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS;
const concurrentSigningNowMs = proposalNowMs + 2_001;
const dir = await mkdtemp(join(tmpdir(), "zyron-stale-now-repro-"));

try {
  const genesis = {
    chainId: "zyron-stale-now-repro-1",
    timestampMs: genesisTimestamp,
    validators: [{ address: validatorAddress, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
  const service = new NodeService(
    await ChainStore.open(genesis, dir),
    await SigningJournal.open(dir),
    validatorPrivate
  );

  let concurrentAdvanceObserved = false;
  const peers = {
    requestAttestations: async () => [],
    requestRoundSkips: async (height, round, previousCertificate = []) => {
      if (!concurrentAdvanceObserved && round === 0) {
        concurrentAdvanceObserved = true;
        // Simulate a legitimate concurrent inbound signing request while the
        // proposer is awaiting peer I/O. Even if the duplicate journal
        // reservation rejects, assertValidatorClock runs first and advances
        // the service's local signer-clock watermark.
        try {
          await service.requestSkipVote(height, round, previousCertificate, concurrentSigningNowMs);
        } catch {
          // The clock-watermark side effect is the condition under test.
        }
      }
      return [];
    },
    broadcastBlock: async () => {}
  };

  await assert.rejects(
    produceFinalizedBlock(service, peers, validatorPrivate, proposalNowMs),
    /Validator clock moved backwards beyond the safety tolerance/,
    "stale captured proposal time should reproduce the current false-positive clock fail-stop"
  );
  assert.equal(concurrentAdvanceObserved, true);
  assert.deepEqual(service.readiness(), {
    ready: false,
    height: 0,
    reasons: ["validator-clock-unhealthy"]
  });

  console.log(JSON.stringify({
    status: "reproduced",
    issue: 221,
    scenario: "stale-proposal-nowMs-after-concurrent-signing",
    proposalNowMs,
    concurrentSigningNowMs,
    deltaMs: concurrentSigningNowMs - proposalNowMs,
    chainHeight: service.status().height,
    readiness: service.readiness(),
    implication: "current code can enter permanent clock fail-stop without the host clock moving backwards"
  }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
}
