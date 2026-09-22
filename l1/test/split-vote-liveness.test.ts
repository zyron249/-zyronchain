import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  createBlockAttestation,
  createSignedBlock,
  hashCouldStillBeFinalized,
  maximumAttestationsPossible,
  uncommittedAttestationRevealThreshold,
  uniquePossiblyFinalizedHash,
  validateUncommittedRoundCertificate,
  validatorQuorumSize
} from "../src/block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { isViewChangeVote, uniquePossiblyFinalizedWithPrepares } from "../src/round-view-change.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { createRpcServer, NodeService, PeerClient, produceFinalizedBlock, type ConsensusPeerClient } from "../src/node.js";
import type { Block, GenesisConfig, PrepareVote, RoundProgressEntry } from "../src/types.js";

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

test("two validators finalize the next round after a prepare/skip split", async () => {
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
    assert.ok(block.roundCertificate.every((entry) => isViewChangeVote(entry)));
    assert.ok(block.roundCertificate.every((entry) => isViewChangeVote(entry) && entry.lockHash === null));

    const conflicting: Block = { ...locked, attestations: onlyProposer.attestations };
    await assert.rejects(
      () => second.acceptFinalizedBlock(conflicting),
      /Refusing non-sequential block persistence|Wrong block height/
    );
    const bothLocked = [validatorOnePrivate, validatorTwoPrivate].map((key, index) => ({
      header: locked.header,
      attestation: createBlockAttestation(locked, key, index === 0 ? validatorOnePublic : validatorTwoPublic)
    }));
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

test("completion bound keeps quorum and refuses an unseen hidden quorum", () => {
  assert.equal(validatorQuorumSize(4), 3);
  assert.equal(validatorQuorumSize(7), 5);
  assert.equal(uncommittedAttestationRevealThreshold(4), 1);
  assert.equal(uncommittedAttestationRevealThreshold(7), 1);
  assert.equal(maximumAttestationsPossible(2, 4, 4), 3);
  assert.equal(hashCouldStillBeFinalized(2, 4, 4), true);
  assert.equal(hashCouldStillBeFinalized(1, 4, 4), false);
  assert.equal(hashCouldStillBeFinalized(0, 4, 4), false);
  assert.equal(hashCouldStillBeFinalized(0, 2, 4), true);
  assert.equal(maximumAttestationsPossible(4, 7, 7), 6);
  assert.equal(hashCouldStillBeFinalized(4, 7, 7), true);
  assert.equal(hashCouldStillBeFinalized(3, 7, 7), true);
  assert.equal(hashCouldStillBeFinalized(2, 7, 7), false);
  assert.equal(hashCouldStillBeFinalized(0, 7, 7), false);
  assert.equal(hashCouldStillBeFinalized(1, 2, 2), false);
  assert.equal(
    uniquePossiblyFinalizedHash([], genesis().validators, genesis().chainId, 1, 0, "ab".repeat(32), 1),
    null
  );
});

test("height-scoped journal reads do not treat height 1 as a prefix of height 11", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-journal-height-"));
  try {
    const journal = await SigningJournal.open(directory);
    await journal.reserveAttestation(1, 0, "ab".repeat(32));
    await journal.reserveSkip(11, 0, "cd".repeat(32));
    assert.deepEqual(journal.choicesAtHeight(1), [{ round: 0, kind: "attest", value: "ab".repeat(32) }]);
    assert.deepEqual(journal.choicesAtHeight(11), [{ round: 0, kind: "skip", value: "cd".repeat(32) }]);
    journal.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function privateKey(byte: number): string {
  return byte.toString(16).padStart(64, "0");
}

function signOutsideJournal(service: NodeService, privateKeyValue: string, publicKey: string, timestampMs: number): Block {
  const unsigned = service.store.chain.prepareBlock([], publicKey, { timestampMs });
  return createSignedBlock({
    version: unsigned.header.version,
    chainId: unsigned.header.chainId,
    height: unsigned.header.height,
    round: unsigned.header.round,
    previousHash: unsigned.header.previousHash,
    timestampMs: unsigned.header.timestampMs,
    transactions: unsigned.transactions,
    stateRoot: unsigned.header.stateRoot,
    proposerPrivateKey: privateKeyValue,
    proposerPublicKey: publicKey
  });
}

async function openValidatorSet(count: number, label: string): Promise<{
  services: NodeService[];
  directories: string[];
  keys: string[];
  publics: string[];
  config: GenesisConfig;
}> {
  const keys = Array.from({ length: count }, (_, index) => privateKey(0x21 + index));
  const publics = keys.map((key) => publicKeyFromPrivate(key));
  const addresses = publics.map((key) => addressFromPublicKey(key));
  const oracle = publicKeyFromPrivate(privateKey(0x3e));
  const pool = addressFromPublicKey(publicKeyFromPrivate(privateKey(0x3f)));
  const config: GenesisConfig = {
    chainId: `zyron-split-n${count}`,
    timestampMs: 1_700_000_000_000,
    validators: addresses.map((address, index) => ({ address, publicKey: publics[index]! })),
    activityOracles: [oracle],
    activityPool: pool,
    allocations: [
      { address: addresses[0]!, amountAtoms: 1_000_000_000 },
      { address: pool, amountAtoms: 5_000_000_000 }
    ]
  };
  const directories: string[] = [];
  const services: NodeService[] = [];
  for (let index = 0; index < count; index += 1) {
    const directory = await mkdtemp(join(tmpdir(), `zyron-${label}-${index}-`));
    directories.push(directory);
    services.push(new NodeService(
      await ChainStore.open(config, directory),
      await SigningJournal.open(directory),
      keys[index]
    ));
  }
  return { services, directories, keys, publics, config };
}

function directPeers(services: NodeService[], nowMs: number): ConsensusPeerClient {
  return {
    async requestPrepares(block) {
      const votes = [];
      for (const service of services) {
        try { votes.push(await service.prepareProposal(block, nowMs)); } catch { /* already prepared or refused */ }
      }
      return votes;
    },
    async requestAttestations(block, prepares = []) {
      const attestations = [];
      for (const service of services) {
        try { attestations.push(await service.attestProposal(block, nowMs, prepares)); } catch { /* already reserved or refused */ }
      }
      return attestations;
    },
    async requestViewChanges(height, round, previousCertificate = [], knownPrepares = []) {
      const votes = [];
      for (const service of services) {
        try { votes.push(await service.requestViewChange(height, round, previousCertificate, knownPrepares, nowMs)); } catch { /* locked without a quorum or already voted */ }
      }
      return votes;
    },
    async requestPrepareReports(height, round, previousHash) {
      const reports = [];
      for (const service of services) {
        try { reports.push(await service.reportPrepare(height, round, previousHash, nowMs)); } catch { /* not at this tip */ }
      }
      return reports;
    },
    async requestRoundSkips(height, round, previousCertificate = []) {
      const votes = [];
      for (const service of services) {
        try { votes.push(await service.requestSkipVote(height, round, previousCertificate, nowMs)); } catch { /* already voted */ }
      }
      return votes;
    },
    async requestLockedAttestations(height, round, previousHash) {
      const evidence = [];
      for (const service of services) {
        try { evidence.push(await service.lockedAttestEvidence(height, round, previousHash, nowMs)); } catch { /* no lock */ }
      }
      return evidence;
    },
    async requestRoundReports(height, round, previousHash) {
      const reports = [];
      for (const service of services) {
        try { reports.push(await service.reportRoundChoice(height, round, previousHash, nowMs)); } catch { /* not at this tip */ }
      }
      return reports;
    },
    async requestCompletionAttestations(block, votes, prepares = []) {
      const attestations = [];
      for (const service of services) {
        try { attestations.push(await service.attestCompletion(block, votes, nowMs, prepares)); } catch { /* refused or already final */ }
      }
      return attestations;
    },
    async broadcastBlock(block) {
      for (const service of services) {
        try { await service.acceptFinalizedBlock(block); } catch { /* producer already accepted */ }
      }
    }
  };
}

async function closeDirs(directories: string[]): Promise<void> {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
}

test("four validators complete the original block after a 2-attest/2-skip split", async () => {
  const opened = await openValidatorSet(4, "split4");
  const servers = opened.services.map((service) => createRpcServer(service));
  try {
    const roundZero = opened.config.timestampMs + 30_000;
    const roundOne = opened.config.timestampMs + 60_000;
    const unsigned = opened.services[0]!.store.chain.prepareBlock([], opened.publics[0]!, { timestampMs: roundZero });
    const locked = await opened.services[0]!.signPreparedProposal(unsigned, roundZero);
    await opened.services[1]!.prepareProposal(locked, roundZero);
    await opened.services[2]!.requestSkipVote(1, 0, [], roundOne);
    await opened.services[3]!.requestSkipVote(1, 0, [], roundOne);
    const alternate = signOutsideJournal(opened.services[0]!, opened.keys[0]!, opened.publics[0]!, roundZero + 1_000);
    assert.notEqual(alternate.hash, locked.hash);
    await assert.rejects(
      () => opened.services[2]!.attestProposal(alternate, roundOne),
      /Conflicting validator action/
    );
    await assert.rejects(
      () => opened.services[0]!.acceptFinalizedBlock({
        ...locked,
        attestations: [0, 1].map((index) => createBlockAttestation(locked, opened.keys[index]!, opened.publics[index]!))
      }),
      /Finality quorum not reached/
    );
    const ports = await Promise.all(servers.map(async (server, index) => {
      if (index === 2) return 0;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Split-vote server has no TCP address");
      return address.port;
    }));
    const peers = new PeerClient(ports.flatMap((port, index) => index === 2 ? [] : [`http://127.0.0.1:${port}`]));
    const block = await produceFinalizedBlock(opened.services[2]!, peers, opened.keys[2]!, roundOne);
    assert.ok(block);
    assert.equal(block.header.round, 0);
    assert.equal(block.hash, locked.hash);
    assert.equal(block.roundCertificate.length, 0);
    assert.ok(block.attestations.length >= validatorQuorumSize(4));
    for (const service of opened.services) {
      assert.equal(service.status().height, 1);
      assert.equal(service.status().tipHash, locked.hash);
    }
    await assert.rejects(
      () => opened.services[0]!.acceptFinalizedBlock(alternate),
      /Refusing non-sequential block persistence|Wrong block height/
    );
  } finally {
    await Promise.all(servers.map((server) => server.listening
      ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      : Promise.resolve()));
    await closeDirs(opened.directories);
  }
});

test("seven validators complete a unique round-0 split and refuse two possibly finalized hashes", async () => {
  for (const attestCount of [4, 3]) {
    const opened = await openValidatorSet(7, `split7-${attestCount}`);
    try {
      const roundZero = opened.config.timestampMs + 30_000;
      const roundOne = opened.config.timestampMs + 60_000;
      const unsigned = opened.services[0]!.store.chain.prepareBlock([], opened.publics[0]!, { timestampMs: roundZero });
      const locked = await opened.services[0]!.signPreparedProposal(unsigned, roundZero);
      for (let index = 1; index < attestCount; index += 1) {
        await opened.services[index]!.prepareProposal(locked, roundZero);
      }
      for (let index = attestCount; index < 7; index += 1) {
        await opened.services[index]!.requestSkipVote(1, 0, [], roundOne);
      }
      const shortAttestations = Array.from({ length: validatorQuorumSize(7) - 1 }, (_, index) =>
        createBlockAttestation(locked, opened.keys[index]!, opened.publics[index]!)
      );
      await assert.rejects(
        () => opened.services[0]!.acceptFinalizedBlock({ ...locked, attestations: shortAttestations }),
        /Finality quorum not reached/
      );
      const block = await produceFinalizedBlock(
        opened.services[attestCount]!,
        directPeers(opened.services.filter((_, index) => index !== attestCount), roundOne),
        opened.keys[attestCount]!,
        roundOne
      );
      assert.ok(block);
      assert.equal(block.header.round, 0);
      assert.equal(block.hash, locked.hash);
      assert.ok(block.attestations.length >= validatorQuorumSize(7));
      for (const service of opened.services) assert.equal(service.status().tipHash, locked.hash);
    } finally {
      await closeDirs(opened.directories);
    }
  }

  const opened = await openValidatorSet(7, "split7-ambiguous");
  try {
    const roundZero = opened.config.timestampMs + 30_000;
    const roundOne = opened.config.timestampMs + 60_000;
    const unsigned = opened.services[0]!.store.chain.prepareBlock([], opened.publics[0]!, { timestampMs: roundZero });
    const first = await opened.services[0]!.signPreparedProposal(unsigned, roundZero);
    await opened.services[1]!.prepareProposal(first, roundZero);
    await opened.services[2]!.prepareProposal(first, roundZero);
    const second = signOutsideJournal(opened.services[0]!, opened.keys[0]!, opened.publics[0]!, roundZero + 1_000);
    assert.notEqual(second.hash, first.hash);
    await opened.services[3]!.prepareProposal(second, roundZero + 1_000);
    await opened.services[4]!.prepareProposal(second, roundZero + 1_000);
    await opened.services[5]!.prepareProposal(second, roundZero + 1_000);
    await opened.services[6]!.requestSkipVote(1, 0, [], roundOne);
    const votes: RoundProgressEntry[] = [];
    for (const service of opened.services) {
      const report = await service.reportRoundChoice(1, 0, first.header.previousHash, roundOne);
      if (report.choice === "skip" && report.skip) votes.push(report.skip);
      if (report.choice === "attest" && report.evidence) votes.push(report.evidence);
    }
    assert.equal(uniquePossiblyFinalizedHash(
      votes,
      opened.config.validators,
      opened.config.chainId,
      1,
      0,
      first.header.previousHash,
      1
    ), null);
    const prepares: PrepareVote[] = [];
    for (const service of opened.services) {
      const report = await service.reportPrepare(1, 0, first.header.previousHash, roundOne);
      if (report.vote) prepares.push(report.vote);
    }
    assert.equal(uniquePossiblyFinalizedWithPrepares(
      votes,
      prepares,
      opened.config.validators,
      opened.config.chainId,
      1,
      0,
      first.header.previousHash,
      1
    ), null);
    await assert.rejects(
      () => opened.services[6]!.attestCompletion(first, votes, roundOne, prepares),
      /Split completion refused/
    );
    const block = await produceFinalizedBlock(
      opened.services[1]!,
      directPeers(opened.services.filter((_, index) => index !== 1), roundOne),
      opened.keys[1]!,
      roundOne
    );
    assert.ok(block);
    assert.equal(block.header.round, 1);
    assert.equal(block.header.height, 1);
    assert.ok(block.attestations.length >= validatorQuorumSize(7));
    assert.notEqual(block.hash, first.hash);
    assert.notEqual(block.hash, second.hash);
    const tip = block.hash;
    for (const service of opened.services) {
      assert.equal(service.status().height, 1);
      assert.equal(service.status().tipHash, tip);
    }
  } finally {
    await closeDirs(opened.directories);
  }
});
