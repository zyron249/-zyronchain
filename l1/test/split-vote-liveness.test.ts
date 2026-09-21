import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createBlockAttestation,
  uncommittedAttestationRevealThreshold,
  validateUncommittedRoundCertificate,
  validatorQuorumSize
} from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { createRpcServer, NodeService, PeerClient, produceFinalizedBlock } from "../src/node.js";
import type { Block, GenesisConfig, LockedAttestEvidence, RoundSkipVote } from "../src/types.js";

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
    chainId: "zyron-devnet-1",
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

test("uncommitted-round threshold stays below a finality quorum and matches the Byzantine reveal bound", () => {
  for (let validatorCount = 1; validatorCount <= 10; validatorCount += 1) {
    const quorum = validatorQuorumSize(validatorCount);
    const faults = Math.floor((validatorCount - 1) / 3);
    const honestAttesters = quorum - faults;
    const minimumVisible = quorum + honestAttesters - validatorCount;
    assert.equal(uncommittedAttestationRevealThreshold(validatorCount), minimumVisible);
    assert.ok(minimumVisible >= 1);
    assert.ok(minimumVisible <= quorum);
  }
  assert.equal(uncommittedAttestationRevealThreshold(2), 2);
  assert.equal(uncommittedAttestationRevealThreshold(4), 1);
  assert.equal(uncommittedAttestationRevealThreshold(7), 1);
});

test("a locked proposal is retransmitted instead of reserving a second hash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-retransmit-"));
  try {
    const service = new NodeService(
      await ChainStore.open(genesis(), directory),
      await SigningJournal.open(directory),
      validatorOnePrivate
    );
    const firstTime = genesis().timestampMs + 30_000;
    const first = service.store.chain.prepareBlock([], validatorOnePublic, { timestampMs: firstTime });
    const signed = await service.signPreparedProposal(first, firstTime);
    const later = service.store.chain.prepareBlock([], validatorOnePublic, { timestampMs: firstTime + 1_000 });
    const retransmitted = await service.signPreparedProposal(later, firstTime + 1_000);
    assert.equal(retransmitted.hash, signed.hash);
    assert.equal(retransmitted.header.timestampMs, signed.header.timestampMs);
    await assert.rejects(
      () => service.requestSkipVote(1, 0, [], firstTime + 60_000),
      /Conflicting validator action/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two validators finalize the next round after an attest/skip split", async () => {
  const firstDir = await mkdtemp(join(tmpdir(), "zyron-split-a-"));
  const secondDir = await mkdtemp(join(tmpdir(), "zyron-split-b-"));
  const first = new NodeService(
    await ChainStore.open(genesis(), firstDir),
    await SigningJournal.open(firstDir),
    validatorOnePrivate
  );
  const second = new NodeService(
    await ChainStore.open(genesis(), secondDir),
    await SigningJournal.open(secondDir),
    validatorTwoPrivate
  );
  const server = createRpcServer(first);
  try {
    const roundZeroTime = genesis().timestampMs + 30_000;
    const roundOneTime = genesis().timestampMs + 60_000;
    const unsigned = first.store.chain.prepareBlock([], validatorOnePublic, { timestampMs: roundZeroTime });
    const locked = await first.signPreparedProposal(unsigned, roundZeroTime);
    const onlyProposer = {
      ...locked,
      attestations: [createBlockAttestation(locked, validatorOnePrivate, validatorOnePublic)]
    };
    await assert.rejects(() => first.acceptFinalizedBlock(onlyProposer), /Finality quorum not reached/);
    await second.requestSkipVote(1, 0, [], roundOneTime);

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Split-vote test server has no TCP address");
    const peers = new PeerClient([`http://127.0.0.1:${address.port}`]);
    const block = await produceFinalizedBlock(second, peers, validatorTwoPrivate, roundOneTime);
    assert.ok(block);
    assert.equal(block.header.round, 1);
    assert.equal(block.header.height, 1);
    assert.equal(block.roundCertificate.length, 2);
    assert.equal(block.attestations.length, 2);
    assert.equal(first.status().height, 1);
    assert.equal(second.status().height, 1);
    assert.equal(second.status().tipHash, first.status().tipHash);
    assert.notEqual(first.status().tipHash, locked.hash);
    const skips = block.roundCertificate.filter((entry): entry is RoundSkipVote => "previousHash" in entry);
    const locks = block.roundCertificate.filter((entry): entry is LockedAttestEvidence => "header" in entry);
    assert.equal(skips.length, 1);
    assert.equal(skips[0]!.validator, validatorTwo);
    assert.equal(locks.length, 1);
    assert.equal(locks[0]!.attestation.validator, validatorOne);
    assert.equal(locks[0]!.header.round, 0);

    const conflicting: Block = { ...locked, attestations: onlyProposer.attestations };
    await assert.rejects(
      () => second.acceptFinalizedBlock(conflicting),
      /Refusing non-sequential block persistence|Wrong block height/
    );
    const bothLocked = [
      locks[0]!,
      {
        header: locks[0]!.header,
        attestation: createBlockAttestation(locked, validatorTwoPrivate, validatorTwoPublic)
      }
    ];
    assert.throws(
      () => validateUncommittedRoundCertificate(
        bothLocked,
        genesis().validators,
        genesis().chainId,
        1,
        0,
        locked.header.previousHash,
        1
      ),
      /possibly finalized attestation/
    );
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await rm(firstDir, { recursive: true, force: true });
    await rm(secondDir, { recursive: true, force: true });
  }
});
