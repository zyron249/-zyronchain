// F-03 regression: missed round-0 proposer recovery under every supported
// protocol version (1, 2, 3, 5) over both consensus transports.
//
// The active protocol version is reached through real governance: a quorum-
// approved `protocol_upgrade` is finalized at height 1 with activation height
// 101 (MIN_PROTOCOL_UPDATE_DELAY = 100), and the first 100 blocks are committed
// to every validator's on-disk ChainStore. No `protocolVersionAt` monkeypatch
// is used. Height 101 is then the first height under the target version, its
// round-0 proposer is offline, and the round-1 (or round-2) proposer must
// recover through the real `produceFinalizedBlock` path, collecting real
// `requestSkipVote` signatures from its own NodeService and from peers.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import {
  createBlockAttestation,
  createGenesisBlock,
  createRoundSkipVote,
  createSignedBlock,
  expectedValidator,
  validateBlockEnvelope,
  validateRoundSkipQuorum,
  validateRoundSkipVote
} from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND, RoundSkipVoteDiagnostics } from "../src/consensus-diagnostics.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import * as nodeBaseModule from "../src/node-base.js";
import {
  BLOCK_INTERVAL_MS,
  ROUND_WINDOW_MS,
  createRpcServer,
  NodeService,
  PeerClient,
  produceFinalizedBlock,
  type ConsensusPeerClient
} from "../src/node.js";
import { NativeConsensusPeerClient, registerP2PConsensusProtocol } from "../src/p2p-consensus.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createP2PNode } from "../src/p2p.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { Block, GenesisConfig, RoundSkipVote } from "../src/types.js";

const PROTOCOL_VERSIONS = [1, 2, 3, 5] as const;
const RECOVERY_ROUNDS = [1, 2] as const;
const TRANSPORTS = ["http", "native"] as const;
const ACTIVATION_HEIGHT = 101;
const TARGET_HEIGHT = ACTIVATION_HEIGHT;

const validatorPrivateKeys = ["31", "32", "33", "34"].map((byte) => byte.padStart(64, "0"));
const validatorPublicKeys = validatorPrivateKeys.map(publicKeyFromPrivate);
const oraclePublic = publicKeyFromPrivate("35".padStart(64, "0"));
const activityPool = addressFromPublicKey(publicKeyFromPrivate("36".padStart(64, "0")));

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-f03-missed-proposer",
    timestampMs: 1_700_000_000_000,
    validators: validatorPublicKeys.map((publicKey) => ({ address: addressFromPublicKey(publicKey), publicKey })),
    activityOracles: [oraclePublic],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

function privateKeyFor(publicKey: string): string {
  const index = validatorPublicKeys.indexOf(publicKey);
  assert.ok(index >= 0, "unknown validator public key");
  return validatorPrivateKeys[index]!;
}

// Finalized prefix (heights 1..100) per target protocol version, built once in
// memory with a governance-scheduled activation at height 101.
const prefixCache = new Map<number, Block[]>();

function finalizedPrefix(protocolVersion: number): Block[] {
  const cached = prefixCache.get(protocolVersion);
  if (cached) return cached;
  const config = genesis();
  const chain = new ZyronChain(config);
  const transactions = [];
  if (protocolVersion !== 1) {
    const proposerAddress = config.validators[0]!.address;
    const proposal = {
      chainId: config.chainId,
      nonce: 1,
      sender: proposerAddress,
      activationHeight: ACTIVATION_HEIGHT,
      protocolVersion
    };
    transactions.push(createProtocolUpgrade({
      ...proposal,
      approvals: validatorPrivateKeys.map((key, index) =>
        createProtocolUpgradeApproval(proposal, key, validatorPublicKeys[index]!)),
      timestampMs: config.timestampMs + 10
    }, validatorPrivateKeys[0]!, validatorPublicKeys[0]!));
  }
  const blocks: Block[] = [];
  for (let height = 1; height < ACTIVATION_HEIGHT; height += 1) {
    const timestampMs = config.timestampMs + (height * 1_000);
    const proposer = expectedValidator(config.validators, height, 0);
    let block = chain.produceBlock(height === 1 ? transactions : [], privateKeyFor(proposer.publicKey), { timestampMs });
    for (const key of validatorPrivateKeys) block = chain.attestBlock(block, key);
    chain.acceptBlock(block, timestampMs);
    blocks.push(block);
  }
  assert.equal(chain.height, ACTIVATION_HEIGHT - 1);
  assert.equal(chain.protocolVersionAt(ACTIVATION_HEIGHT - 1), 1);
  assert.equal(chain.protocolVersionAt(ACTIVATION_HEIGHT), protocolVersion);
  prefixCache.set(protocolVersion, blocks);
  return blocks;
}

interface Validator {
  index: number;
  directory: string;
  journal: SigningJournal;
  service: NodeService;
}

async function openValidator(index: number, prefix: Block[]): Promise<Validator> {
  const directory = await mkdtemp(join(tmpdir(), `zyron-f03-v${index}-`));
  const store = await ChainStore.open(genesis(), directory);
  for (const block of prefix) await store.commitFinalizedBlock(block);
  const journal = await SigningJournal.open(directory);
  const service = new NodeService(store, journal, validatorPrivateKeys[index]!);
  return { index, directory, journal, service };
}

interface Transport {
  peers: ConsensusPeerClient;
  close(): Promise<void>;
}

async function httpTransport(remotes: Validator[]): Promise<Transport> {
  const servers: Server[] = [];
  const urls: string[] = [];
  try {
    for (const remote of remotes) {
      const server = createRpcServer(remote.service);
      servers.push(server);
      await new Promise<void>((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolveListen());
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("F-03 test server has no TCP address");
      urls.push(`http://127.0.0.1:${address.port}`);
    }
  } catch (error) {
    await closeServers(servers);
    throw error;
  }
  return { peers: new PeerClient(urls), close: () => closeServers(servers) };
}

async function closeServers(servers: Server[]): Promise<void> {
  await Promise.allSettled(servers.filter((server) => server.listening).map((server) =>
    new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))));
}

async function nativeTransport(producer: Validator, remotes: Validator[]): Promise<Transport> {
  const nodes: Array<Awaited<ReturnType<typeof createP2PNode>>> = [];
  try {
    const targets = [];
    for (const remote of remotes) {
      const identity = await loadOrCreateNodeIdentity(remote.directory);
      const node = await createP2PNode(identity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
      nodes.push(node);
      await registerP2PConsensusProtocol(node, identity, remote.service);
      const address = node.getMultiaddrs()[0];
      assert.ok(address, "native consensus listener has no loopback address");
      targets.push(address);
    }
    const producerIdentity = await loadOrCreateNodeIdentity(producer.directory);
    const producerNode = await createP2PNode(producerIdentity);
    nodes.push(producerNode);
    const peers = new NativeConsensusPeerClient(producerNode, targets, producerIdentity, producer.service.status());
    return { peers, close: async () => { await Promise.allSettled(nodes.map((node) => node.stop())); } };
  } catch (error) {
    await Promise.allSettled(nodes.map((node) => node.stop()));
    throw error;
  }
}

for (const protocolVersion of PROTOCOL_VERSIONS) {
  for (const recoveryRound of RECOVERY_ROUNDS) {
    for (const transport of TRANSPORTS) {
      test(
        `F-03 missed round-0 proposer recovers in round ${recoveryRound} under protocol v${protocolVersion} over ${transport} consensus`,
        { timeout: 120_000 },
        async () => {
          const prefix = finalizedPrefix(protocolVersion);
          const config = genesis();
          const validators = config.validators;
          // 4 validators, quorum 3. Height 101: round r proposer is validator index r.
          // Validator 0 (round-0 proposer) is offline for the whole scenario. For the
          // round-2 case, validator 1 also misses its round-1 slot but still votes.
          assert.equal(expectedValidator(validators, TARGET_HEIGHT, 0).publicKey, validatorPublicKeys[0]);
          const producerIndex = recoveryRound;
          assert.equal(expectedValidator(validators, TARGET_HEIGHT, recoveryRound).publicKey, validatorPublicKeys[producerIndex]);
          const online: Validator[] = [];
          let network: Transport | undefined;
          try {
            for (const index of [1, 2, 3]) online.push(await openValidator(index, prefix));
            const producer = online.find((item) => item.index === producerIndex)!;
            const remotes = online.filter((item) => item !== producer);
            assert.equal(producer.service.store.chain.height, TARGET_HEIGHT - 1);
            assert.equal(producer.service.store.chain.protocolVersionAt(TARGET_HEIGHT), protocolVersion);
            const previousHash = producer.service.store.chain.tip.hash;
            const tipTimestampMs = producer.service.store.chain.tip.header.timestampMs;

            network = transport === "http" ? await httpTransport(remotes) : await nativeTransport(producer, remotes);
            const nowMs = tipTimestampMs + BLOCK_INTERVAL_MS + (recoveryRound * ROUND_WINDOW_MS) + 1_000;
            const block = await produceFinalizedBlock(producer.service, network.peers, validatorPrivateKeys[producerIndex]!, nowMs);

            assert.ok(block, `protocol v${protocolVersion}: no round-${recoveryRound} block was produced after the round-0 proposer was missed`);
            assert.equal(block.header.height, TARGET_HEIGHT);
            assert.equal(block.header.round, recoveryRound);
            assert.equal(block.header.version, protocolVersion);
            assert.equal(block.header.previousHash, previousHash);
            assert.equal(block.roundCertificate.length, 3);
            assert.ok(block.roundCertificate.every((vote) => vote.round === recoveryRound - 1 && vote.height === TARGET_HEIGHT));
            assert.ok(block.attestations.length >= 3);

            // The finalized skip certificate validates under the active version...
            assert.doesNotThrow(() => validateRoundSkipQuorum(
              block.roundCertificate, validators, config.chainId, TARGET_HEIGHT, recoveryRound - 1, previousHash, protocolVersion
            ));
            // ...and is genuinely signed in that version's scheme (v>=3 domain-separated,
            // v1/v2 legacy), so checking it under the other scheme must fail.
            const otherScheme = protocolVersion >= 3 ? 1 : 3;
            assert.throws(() => validateRoundSkipQuorum(
              block.roundCertificate, validators, config.chainId, TARGET_HEIGHT, recoveryRound - 1, previousHash, otherScheme
            ), /Invalid round skip signature/);

            // Every online validator independently validated and committed the block.
            for (const validator of online) {
              assert.equal(validator.service.status().height, TARGET_HEIGHT, `validator ${validator.index} did not commit height ${TARGET_HEIGHT}`);
              assert.equal(validator.service.status().tipHash, block.hash);
            }
          } finally {
            await network?.close();
            for (const validator of online) {
              validator.journal.close();
              await rm(validator.directory, { recursive: true, force: true });
            }
          }
        }
      );
    }
  }
}

test("F-03 consensus skip-vote verification APIs reject calls without an explicit protocol version", () => {
  const config = genesis();
  const previous = createGenesisBlock(config, "0".repeat(64));
  const votes = validatorPrivateKeys.slice(0, 3).map((key, index) => createRoundSkipVote({
    chainId: config.chainId,
    height: 1,
    round: 0,
    previousHash: previous.hash,
    validatorPrivateKey: key,
    validatorPublicKey: validatorPublicKeys[index]!,
    protocolVersion: 1
  }));
  // Explicit version: accepted.
  assert.doesNotThrow(() => validateRoundSkipVote(votes[0], config.validators, config.chainId, 1, 0, previous.hash, 1));
  assert.doesNotThrow(() => validateRoundSkipQuorum(votes, config.validators, config.chainId, 1, 0, previous.hash, 1));

  // Omitted version (a JavaScript caller, or a TypeScript caller bypassing the
  // signature): must fail closed instead of silently assuming protocol v1.
  const untypedVote = validateRoundSkipVote as unknown as (...args: unknown[]) => void;
  const untypedQuorum = validateRoundSkipQuorum as unknown as (...args: unknown[]) => void;
  assert.throws(() => untypedVote(votes[0], config.validators, config.chainId, 1, 0, previous.hash), /protocol version/i);
  assert.throws(() => untypedQuorum(votes, config.validators, config.chainId, 1, 0, previous.hash), /protocol version/i);

  // The block envelope verifier must not default to protocol v1 either.
  const timestampMs = config.timestampMs + 1;
  const proposerKey = privateKeyFor(expectedValidator(config.validators, 1, 0).publicKey);
  let block = createSignedBlock({
    version: 1,
    chainId: config.chainId,
    height: 1,
    round: 0,
    previousHash: previous.hash,
    timestampMs,
    transactions: [],
    stateRoot: "1".repeat(64),
    proposerPrivateKey: proposerKey,
    proposerPublicKey: publicKeyFromPrivate(proposerKey)
  });
  block = {
    ...block,
    attestations: validatorPrivateKeys.slice(0, 3).map((key, index) =>
      createBlockAttestation(block, key, validatorPublicKeys[index]!))
  };
  assert.doesNotThrow(() => validateBlockEnvelope(block, previous, config.validators, timestampMs, true, 1));
  const untypedEnvelope = validateBlockEnvelope as unknown as (...args: unknown[]) => void;
  assert.throws(() => untypedEnvelope(block, previous, config.validators, timestampMs, true), /explicit protocol version/);
  // An omitted finality mode must not silently disable the attestation quorum check.
  const unattested = { ...block, attestations: [] };
  assert.throws(() => untypedEnvelope(unattested, previous, config.validators, timestampMs, undefined, 1), /explicit finality mode/);
  assert.throws(() => validateBlockEnvelope(unattested, previous, config.validators, timestampMs, true, 1), /Finality quorum not reached/);
});

test("F-03 only one block producer implementation is exported", () => {
  const baseProducer = (nodeBaseModule as Record<string, unknown>).produceFinalizedBlock;
  assert.ok(
    baseProducer === undefined || baseProducer === produceFinalizedBlock,
    "node-base.ts must not carry a second, divergent produceFinalizedBlock implementation"
  );
});

// Compile-time guard (added with the fix; it cannot compile against the audited
// signatures, which defaulted the version to 1). Never executed.
function requiredProtocolVersionCompileTimeGuard(block: Block, previous: Block): void {
  // @ts-expect-error protocolVersion is a required argument (F-03)
  validateRoundSkipVote({}, [], "chain", 1, 0, "00".repeat(32));
  // @ts-expect-error protocolVersion is a required argument (F-03)
  validateRoundSkipQuorum([], [], "chain", 1, 0, "00".repeat(32));
  // @ts-expect-error expectedProtocolVersion is a required argument (F-03)
  validateBlockEnvelope(block, previous, [], 0, true);
}
void requiredProtocolVersionCompileTimeGuard;

test("F-03 rejected skip votes are counted by reason and logged with bounded, non-sensitive diagnostics", () => {
  const lines: string[] = [];
  const diagnostics = new RoundSkipVoteDiagnostics((line) => lines.push(line));
  const config = genesis();
  const previous = createGenesisBlock(config, "0".repeat(64));
  const vote = createRoundSkipVote({
    chainId: config.chainId,
    height: 1,
    round: 0,
    previousHash: previous.hash,
    validatorPrivateKey: validatorPrivateKeys[0]!,
    validatorPublicKey: validatorPublicKeys[0]!,
    protocolVersion: 3
  });
  const total = MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND + 3;
  for (let index = 0; index < total; index += 1) {
    try {
      validateRoundSkipVote(vote, config.validators, config.chainId, 1, 0, previous.hash, 1);
      assert.fail("v3 vote must not verify under the legacy scheme");
    } catch (error) {
      diagnostics.recordRejectedVote({ height: 1, round: 0, protocolVersion: 1, vote, error });
    }
  }
  diagnostics.recordRejectedVote({
    height: 1,
    round: 1,
    protocolVersion: 3,
    vote: { validator: "x\nforged log line", publicKey: vote.publicKey },
    error: new Error("Invalid round skip vote fields\n" + "y".repeat(500))
  });
  diagnostics.recordQuorumFailure({ height: 1, round: 1, protocolVersion: 3, error: new Error("Round skip quorum not reached: 0/3") });

  const metrics = diagnostics.metrics();
  assert.equal(metrics.rejectedVotes, total + 1);
  assert.equal(metrics.rejectedVotesByReason["invalid-signature"], total);
  assert.equal(metrics.rejectedVotesByReason["malformed-vote"], 1);
  assert.equal(metrics.quorumFailures, 1);
  assert.equal(metrics.suppressedLogLines, total - MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND);
  assert.equal(lines.length, MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND + 2);
  assert.match(lines[0]!, new RegExp(`height=1 round=0 protocolVersion=1 validator=${vote.validator} reason=invalid-signature`));
  for (const line of lines) {
    assert.ok(!line.includes(vote.publicKey), "public keys must not be logged");
    assert.ok(!line.includes(vote.signature), "signatures must not be logged");
    assert.ok(!line.includes("\n"), "log lines must be single-line");
    assert.ok(line.length < 400, "log lines must be bounded");
  }
  assert.match(lines[MAX_LOGGED_ROUND_SKIP_EVENTS_PER_ROUND]!, /validator=unknown reason=malformed-vote/);
});

test("F-03 producer surfaces rejected peer skip votes in node metrics instead of swallowing them", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (line: unknown) => { warnings.push(String(line)); });
  const config = genesis();
  const online: Validator[] = [];
  try {
    for (const index of [1, 2, 3]) online.push(await openValidator(index, []));
    const [producer, second, third] = online as [Validator, Validator, Validator];
    const nowMs = config.timestampMs + BLOCK_INTERVAL_MS + ROUND_WINDOW_MS + 1_000;
    // A vote from the offline round-0 proposer signed under the wrong scheme
    // (domain-separated while protocol v1 is active) must be rejected and counted.
    const forged = createRoundSkipVote({
      chainId: config.chainId,
      height: 1,
      round: 0,
      previousHash: producer.service.store.chain.tip.hash,
      validatorPrivateKey: validatorPrivateKeys[0]!,
      validatorPublicKey: validatorPublicKeys[0]!,
      protocolVersion: 3
    });
    const peers: ConsensusPeerClient = {
      requestRoundSkips: async (height: number, round: number, previousCertificate: RoundSkipVote[] = []) => [
        forged,
        await second.service.requestSkipVote(height, round, previousCertificate, nowMs),
        await third.service.requestSkipVote(height, round, previousCertificate, nowMs)
      ],
      requestAttestations: async (block: Block) => [
        await second.service.attestProposal(block, nowMs),
        await third.service.attestProposal(block, nowMs)
      ],
      broadcastBlock: async (block: Block) => {
        await second.service.acceptFinalizedBlock(block);
        await third.service.acceptFinalizedBlock(block);
      }
    };
    const block = await produceFinalizedBlock(producer.service, peers, validatorPrivateKeys[1]!, nowMs);
    assert.ok(block);
    assert.equal(block.header.round, 1);
    assert.ok(!block.roundCertificate.some((vote) => vote.validator === forged.validator));
    const metrics = producer.service.metrics(nowMs).roundSkipVotes;
    assert.equal(metrics.rejectedVotes, 1);
    assert.equal(metrics.rejectedVotesByReason["invalid-signature"], 1);
    assert.equal(metrics.quorumFailures, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, new RegExp(`Rejected round skip vote: height=1 round=0 protocolVersion=1 validator=${forged.validator} reason=invalid-signature`));
    assert.ok(!warnings[0]!.includes(forged.signature));
    assert.ok(!warnings[0]!.includes(forged.publicKey));
  } finally {
    for (const validator of online) {
      validator.journal.close();
      await rm(validator.directory, { recursive: true, force: true });
    }
  }
});
