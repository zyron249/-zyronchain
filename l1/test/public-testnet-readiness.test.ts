import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validatorQuorumSize } from "../src/block.js";
import { ZyronChain, MIN_PROTOCOL_UPDATE_DELAY } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { decryptPrivateKey } from "../src/keystore.js";
import { assertMiningNetworkIdentity } from "../src/miner-network.js";
import { validateP2PChainIdentity } from "../src/p2p.js";
import { selectMinerRpcEndpoint } from "../src/public-testnet-miner-failover.js";
import {
  assertOperatorLabel,
  createOperatorKeystore,
  readOperatorPublicRecord
} from "../src/public-testnet-operator.js";
import {
  ALLOCATION_HUMAN_INPUTS,
  PUBLIC_TESTNET_CANDIDATE_CHAIN_ID,
  PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME,
  assertChainIdAllowedForClass,
  assertPublicTestnetChainId,
  buildPublicTestnetGenesis,
  firewallPortDecision,
  parsePublicTestnetGovernanceInput,
  publicTestnetAllocationReport,
  assessSoakEvidence
} from "../src/public-testnet-governance.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";
import { assertHostPlacement } from "../src/public-testnet-provisioning.js";
import {
  REHEARSAL_SCENARIOS,
  WORKLOAD_SCENARIOS,
  assessProtocolV5Rehearsal,
  assessRehearsalTopology,
  assessReleaseArtifactPlan,
  assertOperatorDomain,
  assertRollbackAction,
  createMinerCohort,
  freezeFormatDocument,
  parsePublicTestnetFreezeFormat,
  renderPublicTestnetMetrics,
  runMinerWorkload,
  shapeCpuProfile
} from "../src/public-testnet-readiness.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../src/transaction.js";
import type { Block, GenesisConfig } from "../src/types.js";

const execFileAsync = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "../..");
const HASH_A = "ab".repeat(32);
const HASH_B = "cd".repeat(32);

test("candidate governance keeps the decided identity and cannot build a genesis", async () => {
  const candidate = JSON.parse(await readFile(join(root, "config/public-testnet-governance-input.candidate.json"), "utf8"));
  const parsed = parsePublicTestnetGovernanceInput(candidate);
  assert.equal(parsed.status, "candidate-awaiting-operator-input");
  assert.equal(parsed.networkName, PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME);
  assert.equal(parsed.chainId, PUBLIC_TESTNET_CANDIDATE_CHAIN_ID);
  assert.equal(parsed.genesisTimestampMs, null);
  assert.equal(parsed.initialProtocolVersion, 1);
  assert.equal(parsed.protocolV5ActivationPolicy, "quorum-delayed-upgrade");
  assert.equal(parsed.validators.length, 0);
  assert.throws(() => buildPublicTestnetGenesis(candidate), /awaiting operator input and cannot build a genesis/);
  const report = publicTestnetAllocationReport([]);
  assert.deepEqual(report.humanInputsRequired, ALLOCATION_HUMAN_INPUTS);
  assert.equal(report.miningBudgetAtoms, 50_000_000 * ATOMS_PER_ZYN);
  assert.equal(report.maxSupplyAtoms, MAX_SUPPLY_ATOMS);
});

test("zyron-public-testnet-1 is a public-testnet chain id and is rejected for mainnet and local-devnet", () => {
  assertPublicTestnetChainId("zyron-public-testnet-1");
  assert.throws(() => assertPublicTestnetChainId("zyron-mainnet-1"), /mainnet|Invalid public-testnet/);
  assert.throws(() => assertPublicTestnetChainId("zyron-devnet-1"), /local-devnet|Invalid public-testnet/);
  assert.throws(() => assertPublicTestnetChainId("zyron-local-devnet"), /Invalid public-testnet|local-devnet/);
  assert.throws(() => assertChainIdAllowedForClass("zyron-public-testnet-1", "mainnet"), /Mainnet must not/);
  assert.throws(() => assertChainIdAllowedForClass("zyron-public-testnet-1", "local-devnet"), /Local-devnet cannot/);
  assertChainIdAllowedForClass("zyron-public-testnet-1", "public-testnet");
});

test("wrong chain id and genesis hash fail closed on P2P and miner RPC identity", () => {
  const expected = { chainId: "zyron-public-testnet-1", genesisHash: HASH_B };
  assert.throws(() => validateP2PChainIdentity({
    version: 1,
    nodeId: "11".repeat(32),
    publicKey: "22".repeat(64),
    chainId: "zyron-devnet-1",
    genesisHash: HASH_B
  }, expected, { toString: () => "12D3KooWunused" }), /P2P chain identity mismatch/);
  assert.throws(() => validateP2PChainIdentity({
    version: 1,
    nodeId: "11".repeat(32),
    publicKey: "22".repeat(64),
    chainId: "zyron-public-testnet-1",
    genesisHash: HASH_A
  }, expected, { toString: () => "12D3KooWunused" }), /P2P chain identity mismatch/);
  assert.throws(() => assertMiningNetworkIdentity({
    chainId: "zyron-devnet-1",
    genesisHash: HASH_B,
    height: 1,
    tipHash: HASH_A
  }, expected.chainId, expected.genesisHash), /chain ID/);
  assert.throws(() => assertMiningNetworkIdentity({
    chainId: "zyron-public-testnet-1",
    genesisHash: HASH_A,
    height: 1,
    tipHash: HASH_A
  }, expected.chainId, expected.genesisHash), /genesis hash/);
});

test("firewall port matrix denies public consensus and allows only assigned bootstrap and RPC 443", () => {
  assert.equal(firewallPortDecision({ source: "internet", role: "public-rpc", port: 443 }), "allow");
  assert.equal(firewallPortDecision({ source: "internet", role: "public-rpc", port: 80 }), "deny");
  assert.equal(firewallPortDecision({ source: "internet", role: "validator-consensus", port: 9140 }), "deny");
  assert.equal(firewallPortDecision({ source: "internet", role: "validator-signer", port: 9141 }), "deny");
  assert.equal(firewallPortDecision({ source: "internet", role: "bootstrap-p2p", port: 9140, assignedBootstrapPort: 9140 }), "allow");
  assert.equal(firewallPortDecision({ source: "internet", role: "bootstrap-p2p", port: 9141, assignedBootstrapPort: 9140 }), "deny");
  assert.equal(firewallPortDecision({ source: "miner", role: "public-rpc", port: 443 }), "allow");
  assert.equal(firewallPortDecision({ source: "miner", role: "validator-consensus", port: 9140 }), "deny");
  assert.equal(firewallPortDecision({ source: "monitoring", role: "metrics", port: 9100 }), "allow-private");
  assert.equal(firewallPortDecision({ source: "internet", role: "metrics", port: 9100 }), "deny");
});

test("miner RPC failover moves from A to B, rejects cross-chain status, and refuses private keys", () => {
  const expected = { chainId: "zyron-public-testnet-1", genesisHash: HASH_B };
  const live = { chainId: expected.chainId, genesisHash: expected.genesisHash, height: 4, tipHash: HASH_A };
  const selected = selectMinerRpcEndpoint({
    probes: [
      { url: "https://rpc-a.bootstrap-fixture.net", reachable: false },
      { url: "https://rpc-b.bootstrap-fixture.net", reachable: true, status: live }
    ],
    expectedChainId: expected.chainId,
    expectedGenesisHash: expected.genesisHash,
    previousWork: { height: 3, tipHash: HASH_B },
    attempt: 1,
    nowMs: 1_000,
    windowStartedAtMs: 0,
    attemptsInWindow: 1
  });
  assert.equal(selected.selectedUrl, "https://rpc-b.bootstrap-fixture.net");
  assert.equal(selected.staleWorkInvalidated, true);
  assert.equal(selected.rejected[0]?.reason, "unreachable");
  assert.equal(selected.spamRefused, false);
  assert.ok(selected.backoffMs >= 500);
  const wrongChain = selectMinerRpcEndpoint({
    probes: [{
      url: "https://rpc-b.bootstrap-fixture.net",
      reachable: true,
      status: { ...live, chainId: "zyron-devnet-1" }
    }],
    ...expectedFields(expected),
    attempt: 0,
    nowMs: 1_000,
    windowStartedAtMs: 0,
    attemptsInWindow: 0
  });
  assert.equal(wrongChain.selectedUrl, null);
  assert.equal(wrongChain.rejected[0]?.reason, "chain-id-mismatch");
  const wrongGenesis = selectMinerRpcEndpoint({
    probes: [{
      url: "https://rpc-b.bootstrap-fixture.net",
      reachable: true,
      status: { ...live, genesisHash: HASH_A }
    }],
    ...expectedFields(expected),
    attempt: 2,
    nowMs: 2_000,
    windowStartedAtMs: 0,
    attemptsInWindow: 2
  });
  assert.equal(wrongGenesis.rejected[0]?.reason, "genesis-hash-mismatch");
  const spam = selectMinerRpcEndpoint({
    probes: [{ url: "https://rpc-b.bootstrap-fixture.net", reachable: true, status: live }],
    ...expectedFields(expected),
    attempt: 4,
    nowMs: 3_000,
    windowStartedAtMs: 2_500,
    attemptsInWindow: 4
  });
  assert.equal(spam.spamRefused, true);
  assert.equal(spam.selectedUrl, null);
  assert.throws(() => selectMinerRpcEndpoint({
    probes: [],
    ...expectedFields(expected),
    attempt: 0,
    nowMs: 1,
    windowStartedAtMs: 0,
    attemptsInWindow: 0,
    privateMaterial: "secret"
  }), /refuses private key/);
});

test("operator provisioning is exclusive, owner-only, and never prints the private key", async () => {
  assert.throws(() => assertOperatorLabel("validator", "validator-d"), /validator-a/);
  const directory = await mkdtemp(join(tmpdir(), "zyron-operator-"));
  const password = "operator-password";
  const passwordFile = join(directory, "password");
  await writeFile(passwordFile, `${password}\n`, { mode: 0o600 });
  await chmod(passwordFile, 0o600);
  try {
    const record = await createOperatorKeystore({
      role: "validator",
      label: "validator-a",
      directory,
      password
    });
    assert.equal(record.weight, 1);
    assert.equal(record.label, "validator-a");
    assert.equal("multiaddr" in record, false);
    assert.equal(JSON.stringify(record).includes("privateKey"), false);
    const keystoreStat = await lstat(join(directory, "validator-a.keystore.json"));
    assert.equal(keystoreStat.mode & 0o777, 0o600);
    assert.equal(keystoreStat.isSymbolicLink(), false);
    const keystore = JSON.parse(await readFile(join(directory, "validator-a.keystore.json"), "utf8"));
    const privateKey = decryptPrivateKey(keystore, password);
    assert.equal(JSON.stringify(record).includes(privateKey), false);
    const exported = await readOperatorPublicRecord(directory, "validator-a");
    assert.equal(exported.publicKey, record.publicKey);
    assert.equal(exported.nodeIdentity.length, 64);
    await assert.rejects(() => createOperatorKeystore({
      role: "validator",
      label: "validator-a",
      directory,
      password
    }), /overwrite|symlink/);
    const linkDir = await mkdtemp(join(tmpdir(), "zyron-operator-link-"));
    await symlink(join(directory, "validator-a.keystore.json"), join(linkDir, "bootstrap-a.keystore.json"));
    await assert.rejects(() => createOperatorKeystore({
      role: "bootstrap",
      label: "bootstrap-a",
      directory: linkDir,
      password
    }), /symlink or junction/);
    const script = join(root, "scripts/provision-public-testnet-operator.mjs");
    const scriptDir = await mkdtemp(join(tmpdir(), "zyron-operator-script-"));
    const { stdout } = await execFileAsync(process.execPath, [
      script, "--role", "bootstrap", "--label", "bootstrap-b", "--dir", scriptDir, "--password-file", passwordFile
    ]);
    const scriptKeystore = JSON.parse(await readFile(join(scriptDir, "bootstrap-b.keystore.json"), "utf8"));
    const scriptPrivate = decryptPrivateKey(scriptKeystore, password);
    assert.equal(stdout.includes(scriptPrivate), false);
    assert.equal(stdout.includes("multiaddr"), false);
    assert.match(stdout, /"weight": 1/);
    await rm(linkDir, { recursive: true, force: true });
    await rm(scriptDir, { recursive: true, force: true });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deployment templates keep consensus private and do not commit certificates", async () => {
  const deploy = join(root, "deploy/public-testnet");
  const files = await walk(deploy);
  const banned = ["example.com", "localhost", "127.0.0.1", "BEGIN CERTIFICATE", "BEGIN PRIVATE KEY", "placeholder", "changeme"];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const token of banned) assert.equal(text.toLowerCase().includes(token.toLowerCase()), false, `${file} contains ${token}`);
  }
  const nginx = await readFile(join(deploy, "tls/nginx.conf"), "utf8");
  const caddy = await readFile(join(deploy, "tls/Caddyfile"), "utf8");
  assert.match(nginx, /TLSv1\.2 TLSv1\.3/);
  assert.match(caddy, /tls1\.2 tls1\.3/);
  assert.match(nginx, /proposal\/attest/);
  assert.match(nginx, /X-Forwarded-For \$remote_addr/);
  const compose = await readFile(join(deploy, "docker/compose.yaml"), "utf8");
  assert.equal(compose.includes("443:443"), true);
  assert.equal(compose.split("\n").filter((line) => line.trim() === "ports:").length, 1);
  assert.match(compose, /internal: true/);
  const regions = JSON.parse(await readFile(join(deploy, "regions.json"), "utf8"));
  assertHostPlacement(regions.hosts);
  assert.equal(assessRehearsalTopology({
    validators: regions.roles.filter((role: { kind: string }) => role.kind === "validator").length,
    bootstraps: regions.roles.filter((role: { kind: string }) => role.kind === "bootstrap").length,
    publicRpc: regions.roles.filter((role: { kind: string }) => role.kind === "public-rpc").length,
    archive: regions.roles.filter((role: { kind: string }) => role.kind === "archive").length,
    monitoring: regions.roles.filter((role: { kind: string; optional?: boolean }) => role.kind === "monitoring" && role.optional !== true).length,
    regions: regions.regions,
    publicConsensus: regions.roles.some((role: { publicConsensus: boolean }) => role.publicConsensus),
    scenarios: [...REHEARSAL_SCENARIOS]
  }).ok, true);
  assertOperatorDomain("rpc-a.bootstrap-fixture.net");
  assert.throws(() => assertOperatorDomain("rpc.example.com"), /not a live public name|reserved/);
});

test("freeze format, release plan, rollback, metrics, and soak horizons stay fail-closed", async () => {
  const freeze = parsePublicTestnetFreezeFormat(JSON.parse(await readFile(join(root, "config/PUBLIC-TESTNET-FREEZE.schema.json"), "utf8")));
  assert.equal(freeze.official, false);
  assert.deepEqual(parsePublicTestnetFreezeFormat(freezeFormatDocument()).official, false);
  assert.throws(() => parsePublicTestnetFreezeFormat({ ...freezeFormatDocument(), status: "governance-frozen" }), /refused/);
  const release = assessReleaseArtifactPlan({
    targets: ["linux", "darwin", "windows"],
    sha256sums: true,
    sbom: true,
    commit: "648f3aa",
    provenance: true,
    publicationAllowed: false,
    publishRequested: false
  });
  assert.equal(release.readyToPublish, false);
  assert.ok(release.reasons.includes("publication-blocked"));
  assert.throws(() => assertRollbackAction("delete-signing-journal"), /signing-journal/);
  assert.throws(() => assertRollbackAction("regenerate-genesis"), /genesis/);
  assert.throws(() => assertRollbackAction("reuse-chain-id-with-different-genesis"), /chain-id/);
  assertRollbackAction("restart-from-existing-data-directory");
  const metrics = renderPublicTestnetMetrics({
    finalizedHeight: 2,
    finalityLatencyMs: 1,
    peerCount: 3,
    rpcRequests: 1,
    rpcErrors: 0,
    rpcLatencyMs: 1,
    validatorUp: 3,
    validatorSigningFailures: 0,
    miningClaimsAccepted: 0,
    miningClaimsRejected: 0,
    miningClaimsStale: 0,
    stateBytes: 1,
    dbBytes: 1,
    processRssBytes: 1,
    processUptimeSeconds: 1,
    exposure: "operator"
  });
  assert.match(metrics, /zyron_finalized_height 2/);
  assert.throws(() => renderPublicTestnetMetrics({
    finalizedHeight: 0, finalityLatencyMs: 0, peerCount: 0, rpcRequests: 0, rpcErrors: 0, rpcLatencyMs: 0,
    validatorUp: 0, validatorSigningFailures: 0, miningClaimsAccepted: 0, miningClaimsRejected: 0,
    miningClaimsStale: 0, stateBytes: 0, dbBytes: 0, processRssBytes: 0, processUptimeSeconds: 0, exposure: "public"
  }), /public internet/);
  const grown = assessSoakEvidence([
    soak(1, 1_000, "72h"),
    soak(2, 80_000_000, "72h")
  ], "72h");
  assert.equal(grown.progress, false);
  assert.ok(grown.reasons.includes("process-rss-growth"));
  const profile = shapeCpuProfile("very-high");
  assert.equal(profile.hardwareBenchmark, false);
});

test("miner workload cohorts reconcile atoms and fail closed on a reward mismatch", () => {
  const cohort = createMinerCohort(3);
  assert.equal(new Set(cohort.map((miner) => miner.address)).size, 3);
  for (const scenario of WORKLOAD_SCENARIOS) {
    const result = runMinerWorkload({
      cohortSize: scenario === "ramp" ? 10 : 3,
      scenario,
      genesisSupplyAtoms: 0,
      profile: "low",
      chainId: scenario === "wrong-chain" ? "zyron-devnet-1" : "zyron-public-testnet-1",
      genesisHash: HASH_B
    });
    assert.equal(result.critical, false, scenario);
  }
  const fifty = runMinerWorkload({
    cohortSize: 50,
    scenario: "ramp",
    genesisSupplyAtoms: 0,
    profile: "high",
    chainId: "zyron-public-testnet-1",
    genesisHash: HASH_B
  });
  assert.equal(fifty.critical, false);
  assert.equal(fifty.accepted, 4);
  const broken = runMinerWorkload({
    cohortSize: 3,
    scenario: "ramp",
    genesisSupplyAtoms: 0,
    profile: "medium",
    chainId: "zyron-public-testnet-1",
    genesisHash: HASH_B,
    observedRewardsAtoms: [1]
  });
  assert.equal(broken.critical, true);
  assert.ok(broken.reasons.includes("CRITICAL FAIL"));
});

test("private rehearsal activates protocol v5 only after the quorum delay and keeps public mining inactive", () => {
  assert.equal(MIN_PROTOCOL_UPDATE_DELAY, 100);
  assert.equal(validatorQuorumSize(3), 3);
  const keys = [0x51, 0x52, 0x53].map((byte) => {
    const privateKey = byte.toString(16).padStart(64, "0");
    const publicKey = publicKeyFromPrivate(privateKey);
    return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
  });
  const oracle = publicKeyFromPrivate("54".padStart(64, "0"));
  const pool = addressFromPublicKey(publicKeyFromPrivate("55".padStart(64, "0")));
  const genesis: GenesisConfig = {
    chainId: "zyron-public-testnet-rehearsal",
    timestampMs: 1_700_000_000_000,
    validators: keys.map((key) => ({ address: key.address, publicKey: key.publicKey })),
    activityOracles: [oracle],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 0 }]
  };
  const earlyChain = new ZyronChain(genesis);
  const earlyInput = {
    chainId: genesis.chainId,
    nonce: 1,
    sender: keys[0]!.address,
    activationHeight: 100,
    protocolVersion: 5
  };
  const early = createProtocolUpgrade({
    ...earlyInput,
    approvals: keys.map((key) => createProtocolUpgradeApproval(earlyInput, key.privateKey, key.publicKey)),
    timestampMs: genesis.timestampMs + 50
  }, keys[0]!.privateKey, keys[0]!.publicKey);
  assert.throws(() => earlyChain.produceBlock([early], keys[0]!.privateKey, { timestampMs: genesis.timestampMs + 100 }), /too soon/);
  const chain = new ZyronChain(genesis);
  assert.equal(chain.protocolVersionAt(0), 1);
  const input = { ...earlyInput, activationHeight: 101 };
  const upgrade = createProtocolUpgrade({
    ...input,
    approvals: keys.map((key) => createProtocolUpgradeApproval(input, key.privateKey, key.publicKey)),
    timestampMs: genesis.timestampMs + 50
  }, keys[0]!.privateKey, keys[0]!.publicKey);
  const blocks: Block[] = [];
  for (let height = 1; height <= 101; height += 1) {
    const proposer = keys[(height - 1) % keys.length]!;
    let block = chain.produceBlock(height === 1 ? [upgrade] : [], proposer.privateKey, {
      timestampMs: genesis.timestampMs + (height * 100)
    });
    for (const key of keys) block = chain.attestBlock(block, key.privateKey);
    chain.acceptBlock(block, genesis.timestampMs + (height * 100));
    blocks.push(block);
  }
  assert.equal(chain.protocolVersionAt(100), 1);
  assert.equal(chain.protocolVersionAt(101), 5);
  const restarted = new ZyronChain(genesis);
  for (const block of blocks) restarted.acceptBlock(block, block.header.timestampMs);
  assert.equal(restarted.tip.hash, chain.tip.hash);
  const wrong = new ZyronChain({ ...genesis, chainId: "zyron-public-testnet-other" });
  assert.throws(() => wrong.acceptBlock(blocks[0]!, blocks[0]!.header.timestampMs));
  assert.equal(assessProtocolV5Rehearsal({
    genesisProtocolVersion: 1,
    proposalHeight: 1,
    activationHeight: 101,
    approvals: 3,
    validatorCount: 3,
    publicMiningActivated: false,
    delayBypassed: false,
    activationPolicy: "quorum-delayed-upgrade"
  }).ok, true);
  assert.equal(assessProtocolV5Rehearsal({
    genesisProtocolVersion: 1,
    proposalHeight: 1,
    activationHeight: 100,
    approvals: 3,
    validatorCount: 3,
    publicMiningActivated: false,
    delayBypassed: false,
    activationPolicy: "quorum-delayed-upgrade"
  }).ok, false);
});

test("preflight prints the network identity summary", async () => {
  const { stdout } = await execFileAsync(process.execPath, [join(root, "scripts/public-testnet-preflight.mjs")]);
  assert.match(stdout, /NETWORK IDENTITY/);
  assert.match(stdout, /Zyron Public Testnet/);
  assert.match(stdout, /zyron-public-testnet-1/);
  assert.match(stdout, /validators: 0\/3/);
  assert.match(stdout, /genesis: NOT BUILT/);
  assert.match(stdout, /mining: INACTIVE/);
  assert.match(stdout, /authorization: BLOCKED/);
  assert.match(stdout, /"engineeringReadiness": "PASS"/);
  assert.match(stdout, /"governanceActivation": "BLOCKED"/);
});

function expectedFields(expected: { chainId: string; genesisHash: string }) {
  return { expectedChainId: expected.chainId, expectedGenesisHash: expected.genesisHash };
}

function soak(height: number, rssBytes: number, duration: "24h" | "72h" | "7d") {
  return {
    duration,
    observedAtMs: height * 1000,
    height,
    finalizedHeight: height,
    finalityLatencyMs: 1,
    validatorAvailable: 3,
    validatorExpected: 3,
    peerCount: 3,
    peerChurn: 0,
    rpcLatencyMs: 1,
    rpcErrors: 0,
    miningClaimsAccepted: 0,
    miningClaimsRejected: 0,
    miningClaimsStale: 0,
    dbBytes: 100,
    stateBytes: 100,
    rssBytes,
    cpuPercent: 1,
    eventLoopDelayMs: 1,
    restarts: 1,
    reconnects: 1,
    syncLagBlocks: 0,
    tipHash: height === 1 ? HASH_A : HASH_B
  };
}

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else files.push(path);
  }
  return files;
}
