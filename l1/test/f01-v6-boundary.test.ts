// F-01 protocol v6: crash points (T4 for every s, T5 fault points), the
// v5 -> v6 activation boundary (T11) and v6 block-envelope validation.
import assert from "node:assert/strict";
import test from "node:test";

import { validateBlockEnvelope, validateBlockShape } from "../src/block.js";
import {
  V6_COMMIT_VOTE_DOMAIN,
  V6_PREPARE_VOTE_DOMAIN,
  roundStart,
  signV6,
  votePayload,
  type V6CommitRequest
} from "../src/consensus-v6.js";
import { ConsensusStateStore } from "../src/consensus-state-store.js";
import { BLOCK_INTERVAL_MS, ROUND_WINDOW_MS, produceFinalizedBlock } from "../src/node.js";
import type { Block } from "../src/types.js";
import {
  ACTIVATION_HEIGHT,
  MemoryNetwork,
  closeValidators,
  finalizedPrefix,
  finalizedPrefixSchedule,
  journalRows,
  openValidator,
  proposerIndex,
  testNetwork,
  type TestNetworkConfig,
  type TestValidator
} from "./support/consensus-harness.js";

const H = ACTIVATION_HEIGHT;

interface Cluster {
  network: TestNetworkConfig;
  prefix: Block[];
  validators: TestValidator[];
  memory: MemoryNetwork;
  clock: number;
}

async function cluster(n: number, firstKeyByte: number, chainId: string, prefix?: Block[]): Promise<Cluster> {
  const network = testNetwork(n, firstKeyByte, chainId);
  const blocks = prefix ?? finalizedPrefix(network, 6);
  const validators: TestValidator[] = [];
  for (let index = 0; index < n; index += 1) validators.push(await openValidator(network, index, blocks));
  const state: Cluster = { network, prefix: blocks, validators, memory: undefined as unknown as MemoryNetwork, clock: 0 };
  state.memory = new MemoryNetwork(validators, () => state.clock);
  return state;
}

function nextHeight(c: Cluster): number {
  return Math.max(...c.validators.map((validator) => validator.service.status().height)) + 1;
}

function tipOf(c: Cluster): number {
  const top = c.validators.reduce((best, validator) => validator.service.status().height > best.service.status().height ? validator : best);
  return top.service.store.chain.tip.header.timestampMs;
}

async function lead(c: Cluster, round: number, offsetMs: number, tipMs: number): Promise<Block | null> {
  const height = nextHeight(c);
  c.clock = roundStart(tipMs, round) + offsetMs;
  const leader = proposerIndex(c.network, height, round);
  if (!c.memory.online[leader]) return null;
  return produceFinalizedBlock(c.validators[leader]!.service, c.memory.peersFor(leader), c.network.privateKeys[leader]!, c.clock);
}

function heal(c: Cluster): void {
  c.memory.drop = () => false;
  c.memory.beforeDeliver = () => {};
  for (let index = 0; index < c.memory.online.length; index += 1) c.memory.online[index] = true;
}

async function restart(c: Cluster, index: number): Promise<TestValidator> {
  const old = c.validators[index]!;
  old.journal.close();
  const reopened = await openValidator(c.network, index, c.prefix, old.directory);
  c.validators[index] = reopened; // MemoryNetwork shares the array
  return reopened;
}

/** Bring lagging validators up to the highest finalized block (block sync stand-in). */
async function syncAll(c: Cluster, block: Block): Promise<void> {
  for (const validator of c.validators) {
    if (validator.service.status().height === block.header.height - 1) await validator.service.acceptFinalizedBlock(block);
  }
}

for (const n of [4, 7]) {
  test(`F-01 v6 T4: n=${n} leader crashes after prepare to s recipients (every s), restarts, re-sends its stored proposal`, { timeout: 240_000 }, async () => {
    const c = await cluster(n, 0x10 + n, `zyron-f01-v6-t4s-n${n}`);
    try {
      // One height per s; the leader rotates with the height.
      for (let s = 0; s < n; s += 1) {
        const height = nextHeight(c);
        const tipMs = tipOf(c);
        const leader = proposerIndex(c.network, height, 0);
        // The prepare request reaches the first s peers (in send order), then the leader crashes.
        const receivers = c.validators.map((_, index) => index).filter((index) => index !== leader).slice(0, s);
        c.memory.drop = (from, to, kind) => from === leader && (kind === "v6-commit" || (kind === "v6-prepare" && !receivers.includes(to)));
        assert.equal(await lead(c, 0, 1_000, tipMs), null, `s=${s}`);
        const proposed = c.validators[leader]!.journal.v6Row(height, 0, "block-proposal");
        assert.ok(proposed);
        const prepared = c.validators.filter((validator) => validator.journal.v6Row(height, 0, "prepare") === proposed).length;
        assert.equal(prepared, s + 1, `s=${s}`); // s recipients + the leader itself
        await restart(c, leader);
        heal(c);
        let block: Block | null;
        if (s % 2 === 0) {
          // Restarted within round 0: it must re-send the stored proposal, never a new block.
          block = await lead(c, 0, 8_000, tipMs);
          assert.ok(block, `s=${s}`);
          assert.equal(block.hash, proposed);
          assert.equal(block.commitRound, 0);
        } else {
          // Restarted after round 0: later rounds finalize (the same block whenever a QC may exist).
          block = null;
          for (let round = 1; round < 5 && !block; round += 1) block = await lead(c, round, 1_000, tipMs);
          assert.ok(block, `s=${s}`);
        }
        await syncAll(c, block);
        for (const validator of c.validators) assert.equal(validator.service.status().height, height, `s=${s}`);
      }
    } finally {
      await closeValidators(c.validators);
    }
  });
}

test("F-01 v6 T5: crash points between QC file, lock+commit rows and signature", { timeout: 120_000 }, async () => {
  const c = await cluster(4, 0x31, "zyron-f01-v6-t5f");
  try {
    const tipMs = (c.validators[0]!.service.store.chain.tip.header.timestampMs);
    const p0 = proposerIndex(c.network, H, 0);
    const [x, y] = [0, 1, 2, 3].filter((index) => index !== p0) as [number, number];
    // Round 0: QC forms, but the commit requests to x and y are lost.
    c.memory.drop = (from, to, kind) => from === p0 && kind === "v6-commit" && (to === x || to === y);
    assert.equal(await lead(c, 0, 1_000, tipMs), null);
    const captured = c.memory.captured.find((item) => item.kind === "v6-commit");
    assert.ok(captured);
    const commitRequest = captured.request as V6CommitRequest;
    const hash = commitRequest.qc.blockHash;

    // Fault point 1 (x): crash after the QC file, before the lock+commit append.
    {
      const validator = c.validators[x]!;
      validator.journal.reserveV6Commit = async () => { throw new Error("simulated crash before lock row"); };
      await assert.rejects(validator.service.v6Commit(structuredClone(commitRequest), c.clock), /simulated crash/);
      const reopened = await restart(c, x);
      assert.equal(reopened.journal.v6Lock(H), null);
      assert.equal(reopened.journal.v6Row(H, 0, "commit"), undefined);
      const stored = await reopened.journal.consensusState.read(ConsensusStateStore.heightFile(H)) as { highQC: { round: number; blockHash: string } };
      assert.equal(stored.highQC.round, 0);
      assert.equal(stored.highQC.blockHash, hash);
    }
    // Fault point 2 (y): crash after the fsynced lock+commit rows, before the signature leaves.
    let firstSignature: string | undefined;
    {
      const validator = c.validators[y]!;
      const original = validator.journal.reserveV6Commit.bind(validator.journal);
      validator.journal.reserveV6Commit = async (...args: Parameters<typeof original>) => {
        await original(...args);
        throw new Error("simulated crash after lock row");
      };
      await assert.rejects(validator.service.v6Commit(structuredClone(commitRequest), c.clock), /simulated crash/);
      const reopened = await restart(c, y);
      assert.deepEqual(reopened.journal.v6Lock(H), { round: 0, blockHash: hash });
      assert.equal(reopened.journal.v6Row(H, 0, "commit"), hash);
      // Retrying the same commit is idempotent and re-signs the identical vote.
      const vote = await reopened.service.v6Commit(structuredClone(commitRequest), c.clock);
      firstSignature = vote.signature;
      const again = await reopened.service.v6Commit(structuredClone(commitRequest), c.clock);
      assert.equal(again.signature, firstSignature);
      // No conflicting vote after restart: an unjustified other block in round 1 is refused.
      await assert.rejects(reopened.journal.reserveV6Prepare(H, 1, "ef".repeat(32), -1), /conflicts with the validator's lock/);
    }
    assert.ok(firstSignature);
    // Fault point 3 (torn lock+commit pair) is covered by f01-journal-v2.test.ts (fail-stop on reopen).
    // Everyone restarts; the lock is carried forward and the same block finalizes.
    await restart(c, p0);
    heal(c);
    let block: Block | null = null;
    for (let round = 1; round < 5 && !block; round += 1) block = await lead(c, round, 1_000, tipMs);
    assert.ok(block);
    assert.equal(block.hash, hash);
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 T11: v5 -> v6 activation boundary with an in-flight legacy round change at A-1", { timeout: 120_000 }, async () => {
  const network = testNetwork(4, 0x41, "zyron-f01-v6-t11");
  // v5 activates at 101 (included at height 1), v6 at A = 120 (included at height 2).
  const A = 120;
  const prefix = finalizedPrefixSchedule(network, [
    { protocolVersion: 5, activationHeight: ACTIVATION_HEIGHT },
    { protocolVersion: 6, activationHeight: A }
  ], A - 2);
  const c = await cluster(4, 0x41, "zyron-f01-v6-t11", prefix);
  try {
    const chain = c.validators[0]!.service.store.chain;
    assert.equal(chain.height, A - 2);
    assert.equal(chain.protocolVersionAt(A - 1), 5);
    assert.equal(chain.protocolVersionAt(A), 6);
    assert.equal(c.validators[0]!.service.v6Metrics(), null); // no consensusV6 metrics at legacy heights
    // v6 handlers refuse at the legacy height A-1.
    const tipMs = chain.tip.header.timestampMs;
    await assert.rejects(c.validators[0]!.service.v6Timeout(A - 1, 0, tipMs + 1_000), /not active/);
    // Height A-1 (v5): the round-0 leader is down; legacy round 1 finalizes with a skip certificate.
    const p0 = proposerIndex(network, A - 1, 0);
    const p1 = proposerIndex(network, A - 1, 1);
    c.memory.online[p0] = false;
    c.clock = tipMs + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS + 500;
    const legacy = await produceFinalizedBlock(c.validators[p1]!.service, c.memory.peersFor(p1), network.privateKeys[p1]!, c.clock);
    assert.ok(legacy);
    assert.equal(legacy.header.version, 5);
    assert.equal(legacy.header.round, 1);
    assert.ok(legacy.roundCertificate.length >= 3);
    assert.equal("commitRound" in legacy, false);
    assert.deepEqual(Object.keys(legacy).sort(), ["attestations", "hash", "header", "proposerPublicKey", "roundCertificate", "signature", "transactions"].sort());
    c.memory.online[p0] = true;
    await c.validators[p0]!.service.acceptFinalizedBlock(legacy);
    for (const validator of c.validators) assert.equal(validator.service.status().height, A - 1);
    // Height A (v6): legacy handlers refuse; v6 finalizes.
    const pA = proposerIndex(network, A, 0);
    const other = (pA + 1) % 4;
    const tipA = c.validators[0]!.service.store.chain.tip.header.timestampMs;
    await assert.rejects(c.validators[other]!.service.requestSkipVote(A, 0, [], tipA + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS + 10), /protocol v6/i);
    const block = await lead(c, 0, 500, tipA);
    assert.ok(block);
    assert.equal(block.header.version, 6);
    assert.equal(block.header.height, A);
    assert.equal(block.commitRound, 0);
    assert.deepEqual(block.roundCertificate, []);
    // The journal holds legacy rows at A-1 and v2 rows at A, never both at one height.
    for (const validator of c.validators) {
      const rows = await journalRows(validator);
      for (const row of rows) {
        const [slot, kind] = row.split("=") as [string, string];
        const height = Number(slot.split(":")[0]);
        if (height === A - 1) assert.match(kind, /^(attest|skip)$/);
        if (height === A) assert.match(kind, /^(block-proposal|proposal|prepare|lock|commit|timeout)$/);
      }
    }
  } finally {
    await closeValidators(c.validators);
  }
});

test("F-01 v6 block envelope: commitRound, empty roundCertificate and commit-domain certificate are enforced", { timeout: 60_000 }, async () => {
  const c = await cluster(4, 0x51, "zyron-f01-v6-envelope");
  try {
    const previous = c.validators[0]!.service.store.chain.tip;
    const validators = c.validators[0]!.service.store.chain.validatorsAt(H);
    const block = await lead(c, 0, 500, previous.header.timestampMs);
    assert.ok(block);
    const now = c.clock;
    validateBlockShape(structuredClone(block));
    validateBlockEnvelope(structuredClone(block), previous, validators, now, true, 6);
    const reject = (mutate: (copy: Block) => void): void => {
      const copy = structuredClone(block);
      mutate(copy);
      assert.throws(() => {
        validateBlockShape(copy);
        validateBlockEnvelope(copy, previous, validators, now, true, 6);
      });
    };
    reject((copy) => { delete (copy as Partial<Block>).commitRound; });
    reject((copy) => { copy.commitRound = null; });
    reject((copy) => { copy.commitRound = 1; }); // votes are bound to the commit round
    reject((copy) => { copy.commitRound = -1; });
    reject((copy) => { copy.attestations = copy.attestations.slice(0, 2); });
    reject((copy) => { copy.attestations = [copy.attestations[0]!, copy.attestations[0]!, copy.attestations[0]!]; });
    reject((copy) => { copy.roundCertificate = [{ ...copy.attestations[0]!, height: H, round: 0 } as never]; });
    // Domain separation: prepare votes over the same payload are not a finality certificate.
    reject((copy) => {
      copy.attestations = c.network.privateKeys.slice(0, 3).map((key, index) => ({
        validator: c.network.genesis.validators[index]!.address,
        publicKey: c.network.publicKeys[index]!,
        signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(c.network.chainId, H, 0, block.hash), key)
      }));
    });
    // A genuine commit certificate from any q validators is accepted.
    const alt = structuredClone(block);
    alt.attestations = c.network.privateKeys.slice(1, 4).map((key, offset) => ({
      validator: c.network.genesis.validators[offset + 1]!.address,
      publicKey: c.network.publicKeys[offset + 1]!,
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(c.network.chainId, H, 0, block.hash), key)
    }));
    validateBlockEnvelope(alt, previous, validators, now, true, 6);
    // Legacy versions keep the exact 7-key block shape: a commitRound key is refused.
    const legacy = structuredClone(previous) as Block;
    assert.equal("commitRound" in legacy, false);
    validateBlockShape(structuredClone(legacy));
    assert.throws(() => validateBlockShape({ ...structuredClone(legacy), commitRound: null }));
  } finally {
    await closeValidators(c.validators);
  }
});
