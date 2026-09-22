import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { INITIAL_MINING_REWARD_ATOMS, validateMiningWork } from "../src/mining.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import {
  assertHostPlacement,
  assertIndependentGenesisReproduction,
  assertNoGenesisRegeneration,
  assertNoSecretFields,
  assertRealBootstrapSet,
  assertSingleMiningClaimPerBlock,
  classifySoakRun,
  explainAllocations,
  formatPublicTestnetPreflight,
  measureClaimShares,
  parseOperatorInputPack,
  searchMiningWorkNonce,
  STOP_SHIP_DOUBLE_HASH_REVIEW,
  validateOperatorHttpsOrigin
} from "../src/public-testnet-provisioning.js";
import { buildPublicTestnetGenesis, preflightCheckedInPublicTestnet } from "../src/public-testnet-governance.js";
import { ChainStore, SigningJournal } from "../src/storage.js";
import { createMiningClaim } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type GenesisConfig } from "../src/types.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "../..");
const repo = join(root, "..");

test("operator pack, placement, origins, and allocations stay non-official", async () => {
  const pack = JSON.parse(await readFile(join(root, "config/public-testnet-operator-input.pack.json"), "utf8"));
  assert.equal(parseOperatorInputPack(pack).officialGenesis, false);
  assert.throws(() => parseOperatorInputPack({ ...pack, privateKey: "aa" }), /secret field/);
  assert.throws(() => parseOperatorInputPack({ ...pack, status: "governance-approved" }), /awaiting real operator input/i);
  const regions = JSON.parse(await readFile(join(root, "deploy/public-testnet/regions.json"), "utf8"));
  assertHostPlacement(regions.hosts);
  const collapsed = regions.hosts.map((host: { roles: string[] }, index: number) => index === 0 ? { ...host, roles: ["validator-a", "bootstrap-a"] } : host);
  assert.throws(() => assertHostPlacement(collapsed), /must not combine/);
  assert.throws(() => assertHostPlacement([
    { id: "combined", region: "region-a", roles: ["validator-a", "validator-b", "validator-c"] }
  ]), /must not combine|missing required hosts/i);
  validateOperatorHttpsOrigin("https://rpc-a.bootstrap-fixture.net");
  assert.throws(() => validateOperatorHttpsOrigin("http://rpc-a.bootstrap-fixture.net"), /HTTPS/);
  assert.throws(() => validateOperatorHttpsOrigin("https://example.com"), /not a live public name/);
  assert.throws(() => validateOperatorHttpsOrigin("https://rpc.localhost"), /not a live public name|DNS/);
  assert.throws(() => validateOperatorHttpsOrigin("https://10.1.1.1"), /private or non-public/);
  assert.throws(() => validateOperatorHttpsOrigin("https://rpc-a.bootstrap-fixture.net/v1"), /path/);
  assert.throws(() => validateOperatorHttpsOrigin("https://rpc-a.bootstrap-fixture.net/?q=1"), /query or fragment/);
  assert.throws(() => validateOperatorHttpsOrigin("https://user:pass@rpc-a.bootstrap-fixture.net"), /credentials/);
  const explained = explainAllocations([]);
  assert.equal(explained.genesisSupplyAtoms, 0);
  assert.equal(explained.miningBudgetAtoms, MAX_SUPPLY_ATOMS);
  assert.throws(() => explainAllocations([{ purpose: "admin", address: "ZYN" + "ab".repeat(20), amountAtoms: 1 }]), /admin/);
  assert.throws(() => explainAllocations([{ purpose: "documented-public-allocation", address: "ZYN" + "ab".repeat(20), amountAtoms: MAX_SUPPLY_ATOMS + 1 }]), /50M/);
  const peers = [0x61, 0x62, 0x63].map((byte, index) => {
    const peerId = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from(byte.toString(16).padStart(64, "0"), "hex"))).toString();
    return {
      peerId,
      multiaddr: `/dns4/bootstrap-${index}.bootstrap-fixture.net/tcp/9140/p2p/${peerId}`,
      failureDomain: `region-${["a", "b", "c"][index]}`
    };
  });
  assertRealBootstrapSet(peers);
  assert.throws(() => assertRealBootstrapSet([peers[0]!, peers[0]!, peers[1]!]), /Duplicate bootstrap peer ID/);
  assert.throws(() => assertRealBootstrapSet(peers.map((peer) => ({ ...peer, failureDomain: "region-a" }))), /three failure domains/);
  assert.match(STOP_SHIP_DOUBLE_HASH_REVIEW, /STOP-SHIP REVIEW/);
  const report = preflightCheckedInPublicTestnet({
    identity: JSON.parse(await readFile(join(root, "config/public-testnet-identity.json"), "utf8")),
    bootstrap: JSON.parse(await readFile(join(root, "config/public-testnet-bootstrap.json"), "utf8")),
    rpc: JSON.parse(await readFile(join(root, "config/public-testnet-rpc.json"), "utf8")),
    minerProfile: JSON.parse(await readFile(join(root, "miner-network-profile.json"), "utf8")),
    authorization: JSON.parse(await readFile(join(repo, "docs/l1-launch-authorization.json"), "utf8")),
    governanceExample: JSON.parse(await readFile(join(root, "config/public-testnet-governance-input.example.json"), "utf8")),
    governanceCandidate: JSON.parse(await readFile(join(root, "config/public-testnet-governance-input.candidate.json"), "utf8"))
  });
  const text = formatPublicTestnetPreflight(report);
  for (const line of ["NETWORK", "GENESIS", "BOOTSTRAP", "RPC", "PROTOCOL", "MINING", "SOAK", "AUTHORIZATION", "AWAITING REAL OPERATOR INPUT", "24h: NOT RUN", "72h: NOT RUN", "7d: NOT RUN"]) {
    assert.match(text, new RegExp(line));
  }
  assert.equal(classifySoakRun([{ observedAtMs: 1_000 }, { observedAtMs: 2_000 }], "24h", true), "NOT RUN");
  const shares = measureClaimShares([2, 1, 1]);
  assert.equal(shares.fairnessProven, false);
  assert.equal(shares.maxShare, 0.5);
});

test("independent genesis bytes match and a frozen chain ID cannot change genesis", () => {
  const keys = [0x71, 0x72, 0x73].map((byte) => publicKeyFromPrivate(byte.toString(16).padStart(64, "0")));
  const oracle = publicKeyFromPrivate("74".padStart(64, "0"));
  const pool = addressFromPublicKey(publicKeyFromPrivate("75".padStart(64, "0")));
  const peers = [0x81, 0x82, 0x83].map((byte, index) => {
    const peerId = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from(byte.toString(16).padStart(64, "0"), "hex"))).toString();
    return {
      peerId,
      multiaddr: `/ip4/${["1.2.3.4", "5.6.7.8", "9.8.7.6"][index]}/tcp/9140/p2p/${peerId}`,
      failureDomain: `region-${["a", "b", "c"][index]}`
    };
  });
  const input = {
    schemaVersion: 1 as const,
    status: "governance-approved" as const,
    networkName: "ci-fixture",
    chainId: "zyron-public-testnet-ci-fixture",
    genesisVersion: 1 as const,
    genesisTimestampMs: 1_700_000_000_000,
    initialProtocolVersion: 1 as const,
    protocolV5ActivationPolicy: "quorum-delayed-upgrade" as const,
    validators: keys.map((publicKey) => ({ publicKey, weight: 1 as const })),
    activityOracles: [oracle],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 0, purpose: "activity-pool" as const }],
    bootstrapPeers: peers,
    publicRpcOrigins: ["https://rpc-a.bootstrap-fixture.net", "https://rpc-b.bootstrap-fixture.net"],
    archiveEndpoints: ["https://archive.bootstrap-fixture.net"],
    monitoringEndpoints: ["https://monitoring.bootstrap-fixture.net"]
  };
  const forward = buildPublicTestnetGenesis(input);
  const reversed = buildPublicTestnetGenesis({ ...input, validators: [...input.validators].reverse(), bootstrapPeers: [...input.bootstrapPeers].reverse() });
  assertIndependentGenesisReproduction(forward.genesisBytes, reversed.genesisBytes);
  assert.equal(forward.report.miningBudgetAtoms, MAX_SUPPLY_ATOMS);
  assertNoGenesisRegeneration(
    { chainId: forward.report.chainId, genesisHash: forward.report.genesisHash },
    { chainId: forward.report.chainId, genesisHash: forward.report.genesisHash }
  );
  assert.throws(() => assertNoGenesisRegeneration(
    { chainId: "zyron-public-testnet-1", genesisHash: forward.report.genesisHash },
    { chainId: "zyron-public-testnet-1", genesisHash: "11".repeat(32) }
  ), /frozen chain ID/);
  assertNoSecretFields({ label: "validator-a", publicKey: keys[0] });
});

test("backup restore keeps chain identity, journal reservation, and tip", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-backup-"));
  const restored = await mkdtemp(join(tmpdir(), "zyron-restore-"));
  try {
    const privateKey = "91".padStart(64, "0");
    const publicKey = publicKeyFromPrivate(privateKey);
    const address = addressFromPublicKey(publicKey);
    const oracle = publicKeyFromPrivate("92".padStart(64, "0"));
    const pool = addressFromPublicKey(publicKeyFromPrivate("93".padStart(64, "0")));
    const genesis: GenesisConfig = {
      chainId: "zyron-public-testnet-rehearsal",
      timestampMs: 1_700_000_000_000,
      validators: [{ address, publicKey }],
      activityOracles: [oracle],
      activityPool: pool,
      allocations: [{ address: pool, amountAtoms: 0 }]
    };
    const identity = await loadOrCreateNodeIdentity(directory);
    const store = await ChainStore.open(genesis, directory);
    const chain = new ZyronChain(genesis);
    let block = chain.produceBlock([], privateKey, { timestampMs: genesis.timestampMs + 100 });
    block = chain.attestBlock(block, privateKey);
    chain.acceptBlock(block, genesis.timestampMs + 100);
    await store.commitFinalizedBlock(block, genesis.timestampMs + 100);
    const journal = await SigningJournal.open(directory);
    await journal.reserveAttestation(1, 0, block.hash);
    journal.close();
    const genesisHash = store.chain.genesisHash;
    const tip = store.chain.tip.hash;
    for (const name of ["metadata.json", "blocks.ndjson", "node-identity.json", "signing-journal.ndjson"]) {
      await cp(join(directory, name), join(restored, name));
      await chmod(join(restored, name), 0o600);
    }
    const restoredIdentity = await loadOrCreateNodeIdentity(restored);
    assert.equal(restoredIdentity.nodeId, identity.nodeId);
    assert.equal(restoredIdentity.publicKey, identity.publicKey);
    const reopened = await ChainStore.open(genesis, restored);
    assert.equal(reopened.chain.genesis.chainId, genesis.chainId);
    assert.equal(reopened.chain.genesisHash, genesisHash);
    assert.equal(reopened.chain.tip.hash, tip);
    const restoredJournal = await SigningJournal.open(restored);
    await assert.rejects(
      () => restoredJournal.reserveAttestation(1, 0, "ab".repeat(32)),
      /Conflicting validator action/
    );
    restoredJournal.close();
    const other: GenesisConfig = { ...genesis, chainId: "zyron-public-testnet-other" };
    await assert.rejects(() => ChainStore.open(other, restored), /different or unsupported chain/);
    assert.equal(JSON.stringify({ nodeId: restoredIdentity.nodeId }).includes(identity.privateKey), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(restored, { recursive: true, force: true });
  }
});

test("first mining claim rehearsal finds 20-bit work for 6.25 ZYN and allows one claim", () => {
  const privateKey = "94".padStart(64, "0");
  const publicKey = publicKeyFromPrivate(privateKey);
  const sender = addressFromPublicKey(publicKey);
  assert.equal(INITIAL_MINING_REWARD_ATOMS, 6.25 * ATOMS_PER_ZYN);
  const found = searchMiningWorkNonce({
    chainId: "zyron-public-testnet-rehearsal",
    nonce: 1,
    sender,
    height: 101,
    previousHash: "ab".repeat(32),
    rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
    publicKey
  });
  const claim = createMiningClaim({
    chainId: "zyron-public-testnet-rehearsal",
    nonce: 1,
    sender,
    height: 101,
    previousHash: "ab".repeat(32),
    rewardAtoms: INITIAL_MINING_REWARD_ATOMS,
    workNonce: found.workNonce,
    timestampMs: 1_700_000_000_000
  }, privateKey, publicKey);
  validateMiningWork(claim);
  assertSingleMiningClaimPerBlock(1);
  assert.throws(() => assertSingleMiningClaimPerBlock(2), /at most one mining claim/);
  assert.ok(found.trials >= 1);
});
