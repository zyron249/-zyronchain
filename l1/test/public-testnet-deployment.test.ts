import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { INITIAL_MINING_REWARD_ATOMS, miningRewardAtoms } from "../src/mining.js";
import { createRpcServer, rpcRateLimitIdentity, type NodeService } from "../src/node.js";
import { validateP2PChainIdentity } from "../src/p2p.js";
import {
  CONSENSUS_HTTP_PATHS,
  HUMAN_INPUTS_REQUIRED,
  PUBLIC_TESTNET_FIREWALL,
  admitPublicRpcDeploymentEnv,
  assessFinalizedHashes,
  assessSoakEvidence,
  buildPublicTestnetGenesis,
  firewallDecision,
  inspectBootstrapDeployment,
  parsePublicTestnetGovernanceInput,
  parseSoakEvidenceCsv,
  preflightCheckedInPublicTestnet,
  publicProxyRouteClass,
  reconcileMiningIssuance,
  reconcileMultiMinerCohort
} from "../src/public-testnet-governance.js";
import type { ApprovedPublicTestnetGovernance } from "../src/public-testnet-governance.js";

const execFileAsync = promisify(execFile);
const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "../..");
const repo = join(root, "..");

function peerId(index: number): string {
  return peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from(index.toString(16).padStart(64, "0"), "hex"))).toString();
}

function approvedFixture(): ApprovedPublicTestnetGovernance {
  const validatorKeys = [0x31, 0x32, 0x33].map((byte) => publicKeyFromPrivate(byte.toString(16).padStart(64, "0")));
  const oracle = publicKeyFromPrivate("34".padStart(64, "0"));
  const pool = addressFromPublicKey(publicKeyFromPrivate("35".padStart(64, "0")));
  const ids = [peerId(0x41), peerId(0x42), peerId(0x43)];
  const hosts = ["1.2.3.4", "5.6.7.8", "9.8.7.6"];
  return {
    schemaVersion: 1,
    status: "governance-approved",
    networkName: "ci-fixture",
    chainId: "zyron-public-testnet-ci-fixture",
    genesisVersion: 1,
    genesisTimestampMs: 1_700_000_000_000,
    initialProtocolVersion: 1,
    protocolV5ActivationPolicy: "quorum-delayed-upgrade",
    validators: validatorKeys.map((publicKey) => ({ publicKey, weight: 1 })),
    activityOracles: [oracle],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 0, purpose: "activity-pool" }],
    bootstrapPeers: ids.map((id, index) => ({
      peerId: id,
      multiaddr: `/ip4/${hosts[index]}/tcp/9140/p2p/${id}`,
      failureDomain: `region-${["a", "b", "c"][index]}`
    })),
    publicRpcOrigins: ["https://rpc-a.bootstrap-fixture.net", "https://rpc-b.bootstrap-fixture.net"],
    archiveEndpoints: ["https://archive.bootstrap-fixture.net"],
    monitoringEndpoints: ["https://monitoring.bootstrap-fixture.net"]
  };
}

test("example governance parses and cannot build a genesis", async () => {
  const example = JSON.parse(await readFile(join(root, "config/public-testnet-governance-input.example.json"), "utf8"));
  const parsed = parsePublicTestnetGovernanceInput(example);
  assert.equal(parsed.status, "example-unfilled");
  assert.equal(parsed.chainId, null);
  assert.throws(() => buildPublicTestnetGenesis(example), /cannot build a genesis/);
  assert.throws(() => buildPublicTestnetGenesis({ ...approvedFixture(), chainId: null, status: "governance-approved" }), /chain ID/);
  assert.throws(() => buildPublicTestnetGenesis({ ...approvedFixture(), chainId: "zyron-public-testnet-example.com" }), /chain ID|placeholder|example/);
  assert.throws(() => buildPublicTestnetGenesis({ ...approvedFixture(), genesisTimestampMs: null }), /timestamp/);
  assert.throws(() => buildPublicTestnetGenesis({
    ...approvedFixture(),
    validators: [{ publicKey: approvedFixture().validators[0]!.publicKey, weight: 2 }]
  }), /weights are not a consensus feature/);
  assert.throws(() => buildPublicTestnetGenesis({
    ...approvedFixture(),
    allocations: [{ ...approvedFixture().allocations[0]!, purpose: "founder" }]
  }), /Founder, premine, and team/);
});

test("identical governance inputs produce identical genesis bytes and hashes", () => {
  const forward = approvedFixture();
  const reversed = {
    ...forward,
    validators: [...forward.validators].reverse(),
    bootstrapPeers: [...forward.bootstrapPeers].reverse()
  };
  const first = buildPublicTestnetGenesis(forward);
  const second = buildPublicTestnetGenesis(reversed);
  assert.equal(first.genesisBytes, second.genesisBytes);
  assert.equal(first.report.genesisSha256, second.report.genesisSha256);
  assert.equal(first.report.genesisHash, second.report.genesisHash);
  assert.equal(first.report.validatorSetHash, second.report.validatorSetHash);
  assert.equal(first.report.configurationHash, second.report.configurationHash);
  assert.equal(first.report.chainId, "zyron-public-testnet-ci-fixture");
  assert.equal(first.report.activationFlagsFalse, true);
  assert.deepEqual(first.genesis.validators.map((validator) => validator.publicKey), [...forward.validators].map((validator) => validator.publicKey).sort());
});

test("genesis builder script is deterministic and rejects the example file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-genesis-pipeline-"));
  const configPath = join(directory, "governance.json");
  const firstOut = join(directory, "one");
  const secondOut = join(directory, "two");
  await writeFile(configPath, `${JSON.stringify(approvedFixture())}\n`);
  const script = join(root, "scripts/build-public-testnet-genesis.mjs");
  try {
    await execFileAsync(process.execPath, [script, "--config", configPath, "--out", firstOut]);
    await execFileAsync(process.execPath, [script, "--config", configPath, "--out", secondOut]);
    const firstGenesis = await readFile(join(firstOut, "genesis.json"));
    const secondGenesis = await readFile(join(secondOut, "genesis.json"));
    assert.deepEqual(firstGenesis, secondGenesis);
    const firstReport = JSON.parse(await readFile(join(firstOut, "genesis-report.json"), "utf8"));
    const secondReport = JSON.parse(await readFile(join(secondOut, "genesis-report.json"), "utf8"));
    assert.equal(firstReport.genesisHash, secondReport.genesisHash);
    assert.equal(firstReport.genesisSha256, secondReport.genesisSha256);
    const example = join(root, "config/public-testnet-governance-input.example.json");
    await assert.rejects(
      () => execFileAsync(process.execPath, [script, "--config", example, "--out", join(directory, "example-out")]),
      /cannot build a genesis/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bootstrap preflight rejects fewer than three peers, duplicate ids, and one domain three times", () => {
  const peers = approvedFixture().bootstrapPeers;
  assert.deepEqual(inspectBootstrapDeployment(peers).errors, []);
  assert.deepEqual(inspectBootstrapDeployment(peers.slice(0, 2)).errors, ["bootstrap-count-below-3", "bootstrap-failure-domains-below-3"]);
  assert.ok(inspectBootstrapDeployment([peers[0]!, peers[0]!, peers[1]!]).errors.includes("duplicate-bootstrap-peer-id"));
  const sameDomain = peers.map((peer) => ({ ...peer, failureDomain: "region-a" }));
  assert.ok(inspectBootstrapDeployment(sameDomain).errors.includes("failure-domain-repeated-three-times"));
  const repeated = [peers[0]!, { ...peers[1]!, failureDomain: "region-a" }, peers[2]!];
  assert.deepEqual(inspectBootstrapDeployment(repeated).warnings, ["failure-domain-repeated"]);
  assert.throws(() => buildPublicTestnetGenesis({ ...approvedFixture(), bootstrapPeers: sameDomain }), /failure-domain-repeated-three-times/);
});

test("checked-in preflight stays fail-closed and governance-blocked", async () => {
  const report = preflightCheckedInPublicTestnet({
    identity: JSON.parse(await readFile(join(root, "config/public-testnet-identity.json"), "utf8")),
    bootstrap: JSON.parse(await readFile(join(root, "config/public-testnet-bootstrap.json"), "utf8")),
    rpc: JSON.parse(await readFile(join(root, "config/public-testnet-rpc.json"), "utf8")),
    minerProfile: JSON.parse(await readFile(join(root, "miner-network-profile.json"), "utf8")),
    authorization: JSON.parse(await readFile(join(repo, "docs/l1-launch-authorization.json"), "utf8")),
    governanceExample: JSON.parse(await readFile(join(root, "config/public-testnet-governance-input.example.json"), "utf8")),
    governanceCandidate: JSON.parse(await readFile(join(root, "config/public-testnet-governance-input.candidate.json"), "utf8"))
  });
  assert.equal(report.engineeringReadiness, "PASS");
  assert.equal(report.governanceActivation, "BLOCKED");
  assert.equal(report.activationReadiness, "NOT READY FOR ACTIVATION");
  assert.equal(report.chainIdNull, true);
  assert.equal(report.genesisUnpublished, true);
  assert.equal(report.bootstrapPlaceholder, true);
  assert.equal(report.publicRpcInactive, true);
  assert.equal(report.activationFlagsFalse, true);
  assert.equal(report.minerProfileInactive, true);
  assert.equal(report.consensusChanged, false);
  assert.equal(report.miningEconomicsChanged, false);
  assert.equal(report.publicTestnetActivationRequirementsRemaining, 10);
  assert.deepEqual(report.humanInputsRequired, HUMAN_INPUTS_REQUIRED);
  assert.equal(report.networkIdentity.networkName, "Zyron Public Testnet");
  assert.equal(report.networkIdentity.chainId, "zyron-public-testnet-1");
  assert.equal(report.networkIdentity.validators, "0/3");
  assert.equal(report.networkIdentity.bootstraps, "0/3");
  assert.equal(report.networkIdentity.publicRpc, "0/2");
  assert.equal(report.networkIdentity.genesis, "NOT BUILT");
  assert.equal(report.networkIdentity.mining, "INACTIVE");
  assert.equal(report.networkIdentity.authorization, "BLOCKED");
  assert.equal(report.networkIdentity.deploymentReadiness, "NOT READY");
  assert.deepEqual(report.failures, []);
});

test("public RPC deployment env fails closed and a public proxy cannot serve consensus", async () => {
  const closed = admitPublicRpcDeploymentEnv({});
  assert.equal(closed.admitted, false);
  assert.ok(closed.reasons.includes("public-testnet-activation-not-allowed"));
  assert.ok(closed.reasons.includes("ZYRON_PUBLIC_RPC_ORIGIN-missing"));
  const placeholder = admitPublicRpcDeploymentEnv({
    ZYRON_PUBLIC_RPC_ORIGIN: "https://example.com",
    ZYRON_PUBLIC_RPC_BIND: "127.0.0.1",
    ZYRON_PUBLIC_RPC_RATE_LIMIT: "PLACEHOLDER",
    ZYRON_PUBLIC_RPC_MAX_BODY: "65536",
    ZYRON_PUBLIC_RPC_TIMEOUT_MS: "5000",
    ZYRON_PUBLIC_RPC_TRUSTED_PROXY: "localhost"
  });
  assert.equal(placeholder.admitted, false);
  assert.ok(placeholder.reasons.some((reason) => reason.endsWith("-placeholder")));
  assert.equal(firewallDecision("internet", "validator-consensus"), "deny");
  assert.equal(firewallDecision("miner", "public-rpc"), "allow");
  assert.equal(firewallDecision("public-reverse-proxy", "consensus-routes"), "deny");
  assert.equal(PUBLIC_TESTNET_FIREWALL.length >= 9, true);
  for (const path of CONSENSUS_HTTP_PATHS) assert.equal(publicProxyRouteClass(path), "consensus");
  assert.equal(rpcRateLimitIdentity("8.8.8.8", "1.2.3.4", ["9.9.9.9"]), "8.8.8.8");
  assert.equal(rpcRateLimitIdentity("9.9.9.9", "1.2.3.4", ["9.9.9.9"]), "1.2.3.4");

  const server = createRpcServer({} as NodeService, { rpcRole: "public" });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Public RPC test server did not bind");
    for (const route of CONSENSUS_HTTP_PATHS) {
      const denied = await postJson(`127.0.0.1`, address.port, route);
      assert.equal(denied, 403, route);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("wrong chain identity is still rejected and chaos observations fail closed on divergent hashes", () => {
  assert.throws(() => validateP2PChainIdentity({
    version: 1,
    nodeId: "ab".repeat(32),
    publicKey: "cd".repeat(64),
    chainId: "zyron-public-testnet-other",
    genesisHash: "11".repeat(32)
  }, {
    chainId: "zyron-public-testnet-ci-fixture",
    genesisHash: "22".repeat(32)
  }, { toString: () => "12D3KooWunused" }), /P2P chain identity mismatch/);
  const same = assessFinalizedHashes([
    { height: 3, hash: "aa".repeat(32) },
    { height: 3, hash: "aa".repeat(32) }
  ]);
  assert.equal(same.critical, false);
  const divergent = assessFinalizedHashes([
    { height: 3, hash: "aa".repeat(32) },
    { height: 3, hash: "bb".repeat(32) }
  ]);
  assert.equal(divergent.critical, true);
  assert.equal(divergent.reason, "divergent-finalized-hash");
});

test("soak evidence requires finalized progress and mining reconciliation keeps the pinned schedule", () => {
  const first = soakSample(1, "11".repeat(32));
  const second = soakSample(2, "22".repeat(32));
  assert.equal(assessSoakEvidence([first, second], "24h").progress, true);
  assert.equal(assessSoakEvidence([first], "72h").progress, false);
  assert.equal(assessSoakEvidence([second, first], "7d").reasons.includes("finalized-height-decreased"), true);
  const csv = [
    "duration,observedAtMs,height,finalizedHeight,finalityLatencyMs,validatorAvailable,validatorExpected,peerCount,peerChurn,rpcLatencyMs,rpcErrors,miningClaimsAccepted,miningClaimsRejected,miningClaimsStale,dbBytes,stateBytes,rssBytes,cpuPercent,eventLoopDelayMs,restarts,reconnects,syncLagBlocks,tipHash",
    `24h,1000,1,1,10,3,3,3,0,5,0,0,0,0,10,10,10,1,1,0,0,0,${"11".repeat(32)}`,
    `24h,2000,2,2,10,3,3,3,1,5,0,0,0,0,10,10,10,1,1,0,0,0,${"22".repeat(32)}`
  ].join("\n");
  assert.equal(assessSoakEvidence(parseSoakEvidenceCsv(csv), "24h").progress, true);
  const reward = INITIAL_MINING_REWARD_ATOMS;
  assert.equal(reward, 625_000_000);
  const reconciled = reconcileMiningIssuance({ genesisSupplyAtoms: 0, finalizedRewardsAtoms: [reward, miningRewardAtoms(1, 0)] });
  assert.equal(reconciled.ok, true);
  const wrong = reconcileMiningIssuance({ genesisSupplyAtoms: 0, finalizedRewardsAtoms: [reward - 1] });
  assert.equal(wrong.ok, false);
  const cohort = reconcileMultiMinerCohort({
    cohortSize: 3,
    genesisSupplyAtoms: 0,
    miners: [
      { accepted: 1, rejected: 2, stale: 1, duplicate: 0 },
      { accepted: 1, rejected: 0, stale: 0, duplicate: 1 },
      { accepted: 0, rejected: 4, stale: 0, duplicate: 0 }
    ],
    finalizedRewardsAtoms: [reward, miningRewardAtoms(1, 0)]
  });
  assert.equal(cohort.ok, true);
});

function postJson(hostname: string, port: number, route: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname,
      port,
      path: route,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "2",
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
        "x-forwarded-proto": "https"
      }
    }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end("{}");
  });
}

function soakSample(height: number, tipHash: string) {
  return {
    duration: "24h" as const,
    observedAtMs: height * 1000,
    height,
    finalizedHeight: height,
    finalityLatencyMs: 30,
    validatorAvailable: 3,
    validatorExpected: 3,
    peerCount: 3,
    peerChurn: 0,
    rpcLatencyMs: 20,
    rpcErrors: 0,
    miningClaimsAccepted: 0,
    miningClaimsRejected: 0,
    miningClaimsStale: 0,
    dbBytes: 100,
    stateBytes: 100,
    rssBytes: 100,
    cpuPercent: 1,
    eventLoopDelayMs: 1,
    restarts: 0,
    reconnects: 0,
    syncLagBlocks: 0,
    tipHash
  };
}
