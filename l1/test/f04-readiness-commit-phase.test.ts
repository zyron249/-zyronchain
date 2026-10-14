// Round-4 independent retest (PR981, Low): after a protocol v6 attempt that
// formed a prepare QC but failed the commit quorum, a retry reached the prepare
// quorum again and cleared the recorded failure, so /readyz briefly reported
// ready while the commit phase was still failing. A quorum may only clear a
// failure recorded for the same or an earlier phase.
import assert from "node:assert/strict";
import test from "node:test";

import { roundStart } from "../src/consensus-v6.js";
import { produceFinalizedBlock } from "../src/node.js";
import type { ConsensusPeerClient } from "../src/node.js";
import {
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestValidator
} from "./support/consensus-harness.js";

const T = 1_700_000_000_000;
const QUORUM = "consensus-quorum-unreachable";

test("PR981: a v6 prepare quorum on retry does not clear an earlier commit-quorum failure", async () => {
  const network = testNetwork(4, 0x5b, "f04-commit-phase-v6", T);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  try {
    for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
    let clock = 0;
    const memory = new MemoryNetwork(validators, () => clock);
    const height = validators[0]!.service.store.chain.height + 1;
    const leader = proposerIndex(network, height, 0);
    const service = validators[leader]!.service;
    clock = roundStart(service.store.chain.tip.header.timestampMs, 0) + 100;
    memory.drop = (_from, _to, kind) => kind === "v6-commit";
    const peers = memory.peersFor(leader) as ConsensusPeerClient;
    assert.equal(await produceFinalizedBlock(service, peers, network.privateKeys[leader]!, clock), null);
    assert.deepEqual(service.readiness(clock).reasons, [QUORUM]);

    // Retry: prepare quorum forms again; observe readiness while the commit
    // requests are still outstanding.
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const requestCommit = peers.requestV6Commit!.bind(peers);
    peers.requestV6Commit = async (request) => { entered(); await gate; return requestCommit(request); };
    const retry = produceFinalizedBlock(service, peers, network.privateKeys[leader]!, clock);
    let during: string[];
    try {
      await waiting;
      during = service.readiness(clock).reasons;
    } finally {
      release();
      await retry;
    }
    assert.deepEqual(during, [QUORUM], "prepare quorum alone must not clear the commit-quorum failure");
    assert.deepEqual(service.readiness(clock).reasons, [QUORUM]);

    // A full commit quorum finalizes the height and readiness recovers.
    memory.drop = () => false;
    peers.requestV6Commit = requestCommit;
    assert.ok(await produceFinalizedBlock(service, peers, network.privateKeys[leader]!, clock));
    assert.deepEqual(service.readiness(clock).reasons, []);
  } finally {
    await closeValidators(validators);
  }
});

test("PR981: a prepare quorum still clears an earlier prepare-quorum failure", async () => {
  const network = testNetwork(4, 0x5c, "f04-prepare-phase-v6", T);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  try {
    for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
    const service = validators[0]!.service;
    const tip = service.store.chain.tip;
    service.recordConsensusQuorumFailure(tip.header.height + 1, tip.hash, "prepare");
    const now = roundStart(tip.header.timestampMs, 0) + 100;
    assert.deepEqual(service.readiness(now).reasons, [QUORUM]);
    service.recordConsensusQuorumReached(tip.header.height + 1, tip.hash, "round");
    assert.deepEqual(service.readiness(now).reasons, [QUORUM], "an earlier-phase quorum must not clear it");
    service.recordConsensusQuorumReached(tip.header.height + 1, tip.hash, "prepare");
    assert.deepEqual(service.readiness(now).reasons, []);
    service.recordConsensusQuorumFailure(tip.header.height + 1, tip.hash);
    service.recordConsensusQuorumReached(tip.header.height + 1, tip.hash);
    assert.deepEqual(service.readiness(now).reasons, [], "legacy (unphased) behaviour unchanged");
  } finally {
    await closeValidators(validators);
  }
});

// Round-5 (Codex review of #996, P2): a failure recorded for the same tip by a
// later attempt that stopped at an earlier phase (prepare or timeout) replaced
// the stored commit rank, so the next prepare quorum cleared it and /readyz
// reported ready while the commit phase was still unproven. A failure for the
// same tip keeps the highest phase recorded so far.
test("Round-5: a lower-phase failure on the same tip does not downgrade a recorded commit failure", async () => {
  const network = testNetwork(4, 0x5d, "f04-phase-downgrade-unit", T);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  try {
    for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
    const service = validators[0]!.service;
    const tip = service.store.chain.tip;
    const height = tip.header.height + 1;
    const now = roundStart(tip.header.timestampMs, 0) + 100;
    for (const lower of ["prepare", "round"] as const) {
      service.recordConsensusQuorumFailure(height, tip.hash, "commit");
      service.recordConsensusQuorumFailure(height, tip.hash, lower);
      service.recordConsensusQuorumReached(height, tip.hash, lower);
      assert.deepEqual(service.readiness(now).reasons, [QUORUM], `a ${lower} failure must not downgrade the commit failure`);
      service.recordConsensusQuorumReached(height, tip.hash, "prepare");
      service.recordConsensusQuorumReached(height, tip.hash, "round");
      assert.deepEqual(service.readiness(now).reasons, [QUORUM], "only a commit-phase quorum (or a new tip) clears it");
      service.recordConsensusQuorumReached(height, tip.hash, "commit");
      assert.deepEqual(service.readiness(now).reasons, []);
    }
    // A failure for a different tip still replaces the record outright.
    service.recordConsensusQuorumFailure(height, tip.hash, "commit");
    service.recordConsensusQuorumFailure(height + 1, "00".repeat(32), "prepare");
    assert.deepEqual(service.readiness(now).reasons, [], "a record for another tip does not affect this tip");
  } finally {
    await closeValidators(validators);
  }
});

test("Round-5: commit failure, then prepare failure, then a prepare quorum on retry stays not-ready", async () => {
  const network = testNetwork(4, 0x5e, "f04-phase-downgrade-v6", T);
  const prefix = finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  try {
    for (let index = 0; index < 4; index += 1) validators.push(await openValidator(network, index, prefix));
    let clock = 0;
    const memory = new MemoryNetwork(validators, () => clock);
    const height = validators[0]!.service.store.chain.height + 1;
    const leader = proposerIndex(network, height, 0);
    const service = validators[leader]!.service;
    clock = roundStart(service.store.chain.tip.header.timestampMs, 0) + 100;
    const peers = memory.peersFor(leader) as ConsensusPeerClient;

    // 1) prepare QC forms, commit quorum fails.
    memory.drop = (_from, _to, kind) => kind === "v6-commit";
    assert.equal(await produceFinalizedBlock(service, peers, network.privateKeys[leader]!, clock), null);
    assert.deepEqual(service.readiness(clock).reasons, [QUORUM]);

    // 2) a retry cannot even form the prepare quorum.
    memory.drop = (_from, _to, kind) => kind === "v6-prepare" || kind === "v6-commit";
    assert.equal(await produceFinalizedBlock(service, peers, network.privateKeys[leader]!, clock), null);
    assert.deepEqual(service.readiness(clock).reasons, [QUORUM]);

    // 3) the next retry forms the prepare quorum again; observe readiness while
    // the commit requests are still outstanding.
    memory.drop = (_from, _to, kind) => kind === "v6-commit";
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const requestCommit = peers.requestV6Commit!.bind(peers);
    peers.requestV6Commit = async (request) => { entered(); await gate; return requestCommit(request); };
    const retry = produceFinalizedBlock(service, peers, network.privateKeys[leader]!, clock);
    let during: string[];
    try {
      await waiting;
      during = service.readiness(clock).reasons;
    } finally {
      release();
      await retry;
    }
    assert.deepEqual(during, [QUORUM], "a prepare quorum after a downgraded failure must not report ready");
    assert.deepEqual(service.readiness(clock).reasons, [QUORUM]);

    // 4) a full commit quorum finalizes the height and readiness recovers.
    memory.drop = () => false;
    peers.requestV6Commit = requestCommit;
    assert.ok(await produceFinalizedBlock(service, peers, network.privateKeys[leader]!, clock));
    assert.deepEqual(service.readiness(clock).reasons, []);
  } finally {
    await closeValidators(validators);
  }
});
