import { isIP } from "node:net";

import { ZyronChain } from "./chain.js";
import { canonicalJson, sha256Hex } from "./codec.js";
import { addressFromPublicKey } from "./crypto.js";
import { isLoopbackRpcHost } from "./local-security.js";
import {
  INITIAL_MINING_REWARD_ATOMS,
  MINING_DIFFICULTY_BITS,
  MINING_ERA_TARGET_CLAIMS,
  MINING_PROTOCOL_VERSION,
  cumulativeMiningIssuanceAtoms,
  miningRewardAtoms
} from "./mining.js";
import { isGloballyReachableIp } from "./p2p-peer-pool.js";
import { classifyRpcRoute, type RpcRouteClass } from "./public-testnet-rpc.js";
import { parsePublicTestnetIdentity } from "./public-testnet-identity.js";
import { assertExactKeys, assertPlainRecord } from "./transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Address, type GenesisConfig } from "./types.js";

export const PUBLIC_TESTNET_GENESIS_VERSION = 1;
export const PUBLIC_TESTNET_INITIAL_PROTOCOL_VERSION = 1;
export const PUBLIC_TESTNET_V5_ACTIVATION_POLICY = "quorum-delayed-upgrade";
export const PUBLIC_TESTNET_ACTIVATION_REQUIREMENT_COUNT = 10;
export const PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME = "Zyron Public Testnet";
export const PUBLIC_TESTNET_CANDIDATE_CHAIN_ID = "zyron-public-testnet-1";
export const PUBLIC_TESTNET_VALIDATOR_COUNT = 3;
export const PUBLIC_TESTNET_BOOTSTRAP_COUNT = 3;
export const PUBLIC_TESTNET_PUBLIC_RPC_COUNT = 2;
export const PUBLIC_TESTNET_ARCHIVE_COUNT = 1;
export const PUBLIC_TESTNET_MONITORING_COUNT = 1;
export const PUBLIC_TESTNET_REGION_COUNT = 3;
export const SOAK_DURATIONS = ["24h", "72h", "7d"] as const;
export const MINER_COHORT_SIZES = [3, 10, 25, 50] as const;

export const HUMAN_INPUTS_REQUIRED = [
  "genesis timestamp (exact UTC milliseconds)",
  "genesis validator public keys for validator-a, validator-b, and validator-c",
  "activity oracle public key",
  "faucet address and amountAtoms",
  "activity pool address and amountAtoms",
  "operations address and amountAtoms",
  "real bootstrap identities (peer ID, multiaddr, failure domain) for bootstrap-a, bootstrap-b, and bootstrap-c",
  "public HTTPS RPC domains",
  "archive endpoint",
  "monitoring endpoint",
  "hosting regions and providers",
  "activation authorization"
] as const;

export const ALLOCATION_HUMAN_INPUTS = [
  "faucet address and amountAtoms",
  "activity pool address and amountAtoms",
  "operations address and amountAtoms"
] as const;

export const PUBLIC_TESTNET_NODE_BASELINE = {
  minCpuCores: 2,
  minRamGb: 4,
  minDiskGb: 100,
  operatingSystem: "Linux",
  minimumNodeMajor: 22,
  publicHttpsPort: 443,
  validatorConsensus: "private network only",
  filesystem: "persistent disk holding the chain database and the signing journal",
  healthChecks: ["GET /healthz", "GET /readyz", "finalized height increases"]
} as const;

const BANNED_LIVE_TOKENS = ["placeholder", "changeme", "example.com", "localhost", "127.0.0.1", "::1"];
const RESERVED_DNS_SUFFIXES = new Set([
  "local", "localhost", "internal", "lan", "home", "arpa", "invalid", "test", "example", "onion"
]);
const CHAIN_ID_PATTERN = /^zyron-public-testnet-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NETWORK_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/;
const DISPLAY_NAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9 ]{0,62}[A-Za-z0-9])$/;
const DNS_NAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const ALLOCATION_PURPOSES = new Set(["activity-pool", "documented-public-allocation"]);
const REJECTED_ALLOCATION_PURPOSES = new Set([
  "founder", "premine", "team", "hidden", "admin", "emergency", "emergency-mint"
]);

const GOVERNANCE_KEYS = [
  "schemaVersion", "status", "networkName", "chainId", "genesisVersion", "genesisTimestampMs",
  "initialProtocolVersion", "protocolV5ActivationPolicy", "validators", "activityOracles",
  "activityPool", "allocations", "bootstrapPeers", "publicRpcOrigins", "archiveEndpoints",
  "monitoringEndpoints"
] as const;

const VALIDATOR_KEYS = ["publicKey", "weight"] as const;
const ALLOCATION_KEYS = ["address", "amountAtoms", "purpose"] as const;
const BOOTSTRAP_KEYS = ["peerId", "multiaddr", "failureDomain"] as const;

const PUBLIC_RPC_ENV_KEYS = [
  "ZYRON_PUBLIC_RPC_ORIGIN",
  "ZYRON_PUBLIC_RPC_BIND",
  "ZYRON_PUBLIC_RPC_RATE_LIMIT",
  "ZYRON_PUBLIC_RPC_MAX_BODY",
  "ZYRON_PUBLIC_RPC_TIMEOUT_MS",
  "ZYRON_PUBLIC_RPC_TRUSTED_PROXY"
] as const;

export interface PublicTestnetGovernanceValidator {
  publicKey: string;
  weight: 1;
}

export interface PublicTestnetGovernanceAllocation {
  address: Address;
  amountAtoms: number;
  purpose: "activity-pool" | "documented-public-allocation";
}

export interface PublicTestnetGovernanceBootstrap {
  peerId: string;
  multiaddr: string;
  failureDomain: string;
}

export interface ExamplePublicTestnetGovernance {
  schemaVersion: 1;
  status: "example-unfilled";
  networkName: string;
  chainId: null;
  genesisVersion: 1;
  genesisTimestampMs: null;
  initialProtocolVersion: 1;
  protocolV5ActivationPolicy: typeof PUBLIC_TESTNET_V5_ACTIVATION_POLICY;
  validators: [];
  activityOracles: [];
  activityPool: null;
  allocations: [];
  bootstrapPeers: [];
  publicRpcOrigins: [];
  archiveEndpoints: [];
  monitoringEndpoints: [];
}

export interface ApprovedPublicTestnetGovernance {
  schemaVersion: 1;
  status: "governance-approved";
  networkName: string;
  chainId: string;
  genesisVersion: 1;
  genesisTimestampMs: number;
  initialProtocolVersion: 1;
  protocolV5ActivationPolicy: typeof PUBLIC_TESTNET_V5_ACTIVATION_POLICY;
  validators: PublicTestnetGovernanceValidator[];
  activityOracles: string[];
  activityPool: Address;
  allocations: PublicTestnetGovernanceAllocation[];
  bootstrapPeers: PublicTestnetGovernanceBootstrap[];
  publicRpcOrigins: string[];
  archiveEndpoints: string[];
  monitoringEndpoints: string[];
}

export interface CandidatePublicTestnetGovernance {
  schemaVersion: 1;
  status: "candidate-awaiting-operator-input";
  networkName: string;
  chainId: string;
  genesisVersion: 1;
  genesisTimestampMs: null;
  initialProtocolVersion: 1;
  protocolV5ActivationPolicy: typeof PUBLIC_TESTNET_V5_ACTIVATION_POLICY;
  validators: [];
  activityOracles: [];
  activityPool: null;
  allocations: [];
  bootstrapPeers: [];
  publicRpcOrigins: [];
  archiveEndpoints: [];
  monitoringEndpoints: [];
}

export type PublicTestnetGovernanceInput =
  | ExamplePublicTestnetGovernance
  | CandidatePublicTestnetGovernance
  | ApprovedPublicTestnetGovernance;

export interface PublicTestnetGenesisReport {
  genesisSha256: string;
  genesisHash: string;
  chainId: string;
  validatorSetHash: string;
  configurationHash: string;
  genesisVersion: 1;
  initialProtocolVersion: 1;
  protocolV5ActivationPolicy: typeof PUBLIC_TESTNET_V5_ACTIVATION_POLICY;
  validatorCount: number;
  activationFlagsFalse: true;
  genesisSupplyAtoms: number;
  miningBudgetAtoms: number;
}

export interface BuiltPublicTestnetGenesis {
  genesis: GenesisConfig;
  genesisBytes: string;
  report: PublicTestnetGenesisReport;
  reportBytes: string;
}

export interface PublicTestnetPreflightReport {
  engineeringReadiness: "PASS" | "FAIL";
  governanceActivation: "BLOCKED";
  activationReadiness: "NOT READY FOR ACTIVATION";
  chainIdNull: boolean;
  genesisUnpublished: boolean;
  bootstrapPlaceholder: boolean;
  publicRpcInactive: boolean;
  activationFlagsFalse: boolean;
  minerProfileInactive: boolean;
  consensusChanged: false;
  miningEconomicsChanged: false;
  publicTestnetActivationRequirementsRemaining: number;
  humanInputsRequired: readonly string[];
  failures: string[];
  networkIdentity: PublicTestnetNetworkIdentitySummary;
}

export interface PublicTestnetNetworkIdentitySummary {
  networkName: typeof PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME;
  chainId: typeof PUBLIC_TESTNET_CANDIDATE_CHAIN_ID;
  candidateStatus: "candidate-awaiting-operator-input";
  publishedIdentityChainId: null;
  validators: string;
  bootstraps: string;
  publicRpc: string;
  archive: string;
  monitoring: string;
  regions: string;
  genesis: "NOT BUILT" | "BUILT" | "VERIFIED";
  mining: "INACTIVE";
  authorization: "BLOCKED";
  engineeringReadiness: "PASS" | "FAIL";
  deploymentReadiness: "NOT READY";
  activationReadiness: "NOT READY FOR ACTIVATION";
}

export interface FirewallFlow {
  source: string;
  destination: string;
  decision: "allow" | "deny" | "allow-private";
  purpose: string;
}

export interface FirewallPortRule {
  source: "internet" | "miner" | "validator" | "bootstrap" | "monitoring";
  role: "public-rpc" | "validator-consensus" | "validator-signer" | "bootstrap-p2p" | "metrics";
  port: number | "assigned-bootstrap-port" | "any";
  decision: "allow" | "deny" | "allow-private";
  purpose: string;
}

export const PUBLIC_TESTNET_PORT_MATRIX: readonly FirewallPortRule[] = [
  { source: "internet", role: "public-rpc", port: 443, decision: "allow", purpose: "Internet to HTTPS RPC" },
  { source: "internet", role: "validator-consensus", port: "any", decision: "deny", purpose: "Internet to validator consensus" },
  { source: "internet", role: "validator-signer", port: "any", decision: "deny", purpose: "Internet to validator signer" },
  { source: "internet", role: "bootstrap-p2p", port: "assigned-bootstrap-port", decision: "allow", purpose: "Bootstrap P2P only on the assigned port" },
  { source: "miner", role: "public-rpc", port: 443, decision: "allow", purpose: "Miner to HTTPS RPC" },
  { source: "miner", role: "validator-consensus", port: "any", decision: "deny", purpose: "Miner to consensus" },
  { source: "monitoring", role: "metrics", port: "any", decision: "allow-private", purpose: "Metrics stay off the public internet" }
];

export const PUBLIC_TESTNET_FIREWALL: readonly FirewallFlow[] = [
  { source: "internet", destination: "public-rpc", decision: "allow", purpose: "HTTPS public role only" },
  { source: "internet", destination: "validator-consensus", decision: "deny", purpose: "consensus RPC stays off the public internet" },
  { source: "internet", destination: "bootstrap-p2p", decision: "allow", purpose: "dial published bootstrap multiaddrs" },
  { source: "validator", destination: "validator", decision: "allow", purpose: "validator consensus and P2P" },
  { source: "bootstrap", destination: "peer", decision: "allow", purpose: "bootstrap to validator and bootstrap peers" },
  { source: "monitoring", destination: "metrics", decision: "allow-private", purpose: "metrics from the monitoring role only" },
  { source: "miner", destination: "public-rpc", decision: "allow", purpose: "miners use HTTPS public RPC" },
  { source: "miner", destination: "validator-consensus", decision: "deny", purpose: "miners do not reach consensus RPC" },
  { source: "public-reverse-proxy", destination: "consensus-routes", decision: "deny", purpose: "the public role refuses consensus paths" }
];

export const CONSENSUS_HTTP_PATHS = [
  "/proposal/prepare",
  "/proposal/attest",
  "/round/skip",
  "/round/view",
  "/round/prepare-report",
  "/round/lock",
  "/round/report",
  "/round/complete",
  "/block"
] as const;

export const PUBLIC_TESTNET_METRICS = [
  "zyron_finalized_height",
  "zyron_finality_latency_ms",
  "zyron_peer_count",
  "zyron_rpc_requests",
  "zyron_rpc_errors",
  "zyron_rpc_latency_ms",
  "zyron_validator_up",
  "zyron_validator_signing_failures",
  "zyron_mining_claims_accepted",
  "zyron_mining_claims_rejected",
  "zyron_mining_claims_stale",
  "zyron_state_bytes",
  "zyron_db_bytes",
  "zyron_process_rss_bytes",
  "zyron_process_uptime_seconds"
] as const;

export const CRITICAL_ALERTS = [
  "finality-stalled",
  "divergent-finalized-hash",
  "quorum-loss",
  "genesis-or-chain-id-mismatch",
  "signing-failure-burst",
  "state-corruption",
  "public-rpc-total-outage",
  "all-bootstraps-down",
  "reward-or-supply-invariant-violation"
] as const;

export const CHAOS_SCENARIOS = [
  { id: "bootstrap-ab-down", expected: "The remaining bootstrap keeps a dial path. Finality continues while a quorum of validators is reachable." },
  { id: "single-validator-down-up", expected: "Finality continues on the remaining quorum. The returned validator syncs to the same finalized hash." },
  { id: "public-rpc-a-down", expected: "Miners fail over to public RPC B. Consensus ports stay unpublished." },
  { id: "miner-disconnect-reconnect", expected: "A disconnected miner stops submitting. After reconnect it follows the current tip and does not replay a stale claim as canonical." },
  { id: "validator-restart", expected: "The signing journal and chain store reload. The validator rejoins the same finalized hash." },
  { id: "archive-restart", expected: "Archive sync resumes from the last retained height. It does not choose a different tip." },
  { id: "latency-loss", expected: "Delayed votes may skip a round. Finalized hashes stay unique per height." },
  { id: "region-outage", expected: "One abstract region dropping leaves the other two able to keep quorum when their validators are a quorum." },
  { id: "disk-pressure", expected: "A failed disk write fail-stops that node. It must not truncate the signing journal or serve a divergent tip." },
  { id: "crash-recovery", expected: "Restart from the data directory resumes the last durable block and journal reservation." },
  { id: "fresh-sync", expected: "A new node downloads finalized blocks and reaches the same tip hash." },
  { id: "checkpoint-sync", expected: "Checkpoint install still requires the out-of-band tip hash and snapshot digest." },
  { id: "catch-up", expected: "A lagged validator applies the finalized sequence in order and matches the quorum hash." }
] as const;

export type SoakDuration = (typeof SOAK_DURATIONS)[number];

export interface SoakSample {
  duration: SoakDuration;
  observedAtMs: number;
  height: number;
  finalizedHeight: number;
  finalityLatencyMs: number;
  validatorAvailable: number;
  validatorExpected: number;
  peerCount: number;
  peerChurn: number;
  rpcLatencyMs: number;
  rpcErrors: number;
  miningClaimsAccepted: number;
  miningClaimsRejected: number;
  miningClaimsStale: number;
  dbBytes: number;
  stateBytes: number;
  rssBytes: number;
  cpuPercent: number;
  eventLoopDelayMs: number;
  restarts: number;
  reconnects: number;
  syncLagBlocks: number;
  tipHash: string;
}

const SOAK_COLUMNS = [
  "duration", "observedAtMs", "height", "finalizedHeight", "finalityLatencyMs", "validatorAvailable",
  "validatorExpected", "peerCount", "peerChurn", "rpcLatencyMs", "rpcErrors", "miningClaimsAccepted",
  "miningClaimsRejected", "miningClaimsStale", "dbBytes", "stateBytes", "rssBytes", "cpuPercent",
  "eventLoopDelayMs", "restarts", "reconnects", "syncLagBlocks", "tipHash"
] as const;

export function parsePublicTestnetGovernanceInput(value: unknown): PublicTestnetGovernanceInput {
  assertPlainRecord(value, "public-testnet governance input");
  assertExactKeys(value, GOVERNANCE_KEYS, "public-testnet governance input");
  if (value.schemaVersion !== 1) throw new Error("Invalid public-testnet governance schema version");
  if (value.genesisVersion !== PUBLIC_TESTNET_GENESIS_VERSION) throw new Error("Invalid public-testnet genesis version");
  if (value.initialProtocolVersion !== PUBLIC_TESTNET_INITIAL_PROTOCOL_VERSION) {
    throw new Error("Public-testnet genesis must start at protocol version 1");
  }
  if (value.protocolV5ActivationPolicy !== PUBLIC_TESTNET_V5_ACTIVATION_POLICY) {
    throw new Error("Protocol v5 must stay a quorum-delayed upgrade");
  }
  if (value.status === "example-unfilled") return parseExampleGovernance(value);
  if (value.status === "candidate-awaiting-operator-input") return parseCandidateGovernance(value);
  if (value.status === "governance-approved") return parseApprovedGovernance(value);
  throw new Error("Invalid public-testnet governance status");
}

export function buildPublicTestnetGenesis(value: unknown): BuiltPublicTestnetGenesis {
  const input = parsePublicTestnetGovernanceInput(value);
  if (input.status === "example-unfilled") {
    throw new Error("Governance input is an example and cannot build a genesis");
  }
  if (input.status === "candidate-awaiting-operator-input") {
    throw new Error(`Governance candidate is awaiting operator input and cannot build a genesis: ${candidateOperatorGaps().join(", ")}`);
  }
  if (input.chainId === PUBLIC_TESTNET_CANDIDATE_CHAIN_ID && input.validators.length !== PUBLIC_TESTNET_VALIDATOR_COUNT) {
    throw new Error("Zyron Public Testnet requires exactly 3 validators");
  }
  const validators = [...input.validators].sort((left, right) => left.publicKey.localeCompare(right.publicKey));
  const genesis: GenesisConfig = {
    chainId: input.chainId,
    timestampMs: input.genesisTimestampMs,
    validators: validators.map((validator) => ({
      publicKey: validator.publicKey,
      address: addressFromPublicKey(validator.publicKey)
    })),
    activityOracles: [...input.activityOracles].sort((left, right) => left.localeCompare(right)),
    activityPool: input.activityPool,
    allocations: [...input.allocations]
      .map((allocation) => ({ address: allocation.address, amountAtoms: allocation.amountAtoms }))
      .sort((left, right) => left.address.localeCompare(right.address))
  };
  const chain = new ZyronChain(genesis);
  const genesisBytes = `${canonicalJson(genesis)}\n`;
  const supply = publicTestnetAllocationReport(input.allocations);
  const report: PublicTestnetGenesisReport = {
    genesisSha256: sha256Hex(genesisBytes),
    genesisHash: chain.genesisHash,
    chainId: genesis.chainId,
    validatorSetHash: sha256Hex(canonicalJson(genesis.validators)),
    configurationHash: sha256Hex(canonicalJson(normalizeApproved(input))),
    genesisVersion: 1,
    initialProtocolVersion: 1,
    protocolV5ActivationPolicy: PUBLIC_TESTNET_V5_ACTIVATION_POLICY,
    validatorCount: genesis.validators.length,
    activationFlagsFalse: true,
    genesisSupplyAtoms: supply.genesisSupplyAtoms,
    miningBudgetAtoms: supply.miningBudgetAtoms
  };
  return { genesis, genesisBytes, report, reportBytes: `${canonicalJson(report)}\n` };
}

export function inspectBootstrapDeployment(peers: readonly PublicTestnetGovernanceBootstrap[]): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (peers.length < 3) errors.push("bootstrap-count-below-3");
  const peerIds = new Set<string>();
  const domains = new Map<string, number>();
  for (const peer of peers) {
    if (peerIds.has(peer.peerId)) errors.push("duplicate-bootstrap-peer-id");
    peerIds.add(peer.peerId);
    domains.set(peer.failureDomain, (domains.get(peer.failureDomain) ?? 0) + 1);
  }
  if (domains.size < 3) errors.push("bootstrap-failure-domains-below-3");
  for (const count of domains.values()) {
    if (count >= 3) errors.push("failure-domain-repeated-three-times");
    else if (count === 2) warnings.push("failure-domain-repeated");
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function firewallDecision(source: string, destination: string): FirewallFlow["decision"] {
  const flow = PUBLIC_TESTNET_FIREWALL.find((item) => item.source === source && item.destination === destination);
  if (!flow) throw new Error("Unknown public-testnet firewall flow");
  return flow.decision;
}

export function firewallPortDecision(input: {
  source: FirewallPortRule["source"];
  role: FirewallPortRule["role"];
  port: number;
  assignedBootstrapPort?: number;
}): FirewallPortRule["decision"] {
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new Error("Invalid firewall port");
  }
  if (input.role === "validator-consensus" || input.role === "validator-signer") return "deny";
  if (input.source === "miner" && input.role !== "public-rpc") return "deny";
  if (input.role === "public-rpc") return input.port === 443 ? "allow" : "deny";
  if (input.role === "bootstrap-p2p") {
    if (input.assignedBootstrapPort === undefined) throw new Error("Bootstrap firewall requires the assigned port");
    return input.port === input.assignedBootstrapPort ? "allow" : "deny";
  }
  if (input.role === "metrics") return input.source === "monitoring" ? "allow-private" : "deny";
  return "deny";
}

export function publicProxyRouteClass(pathname: string): RpcRouteClass {
  return classifyRpcRoute("POST", pathname);
}

export function admitPublicRpcDeploymentEnv(env: Readonly<Record<string, string | undefined>>): { admitted: false; reasons: string[] } {
  const reasons: string[] = ["public-testnet-activation-not-allowed"];
  for (const key of PUBLIC_RPC_ENV_KEYS) {
    const value = env[key];
    if (value === undefined || value.trim() === "") reasons.push(`${key}-missing`);
    else if (containsBannedLiveToken(value)) reasons.push(`${key}-placeholder`);
  }
  const origin = env.ZYRON_PUBLIC_RPC_ORIGIN;
  if (origin !== undefined && origin.trim() !== "" && !containsBannedLiveToken(origin)) {
    try {
      assertPublicHttpsOrigin(origin);
    } catch {
      reasons.push("ZYRON_PUBLIC_RPC_ORIGIN-not-public-https");
    }
  }
  const bind = env.ZYRON_PUBLIC_RPC_BIND;
  if (bind !== undefined && bind.trim() !== "" && !containsBannedLiveToken(bind)) {
    if (bind === "0.0.0.0" || isLoopbackRpcHost(bind)) reasons.push("ZYRON_PUBLIC_RPC_BIND-not-a-public-deployment-proof");
  }
  return { admitted: false, reasons };
}

export function preflightCheckedInPublicTestnet(documents: {
  identity: unknown;
  bootstrap: unknown;
  rpc: unknown;
  minerProfile: unknown;
  authorization: unknown;
  governanceExample: unknown;
  governanceCandidate: unknown;
}): PublicTestnetPreflightReport {
  const failures: string[] = [];
  const identity = recordOrFail(documents.identity, "identity", failures);
  const bootstrap = recordOrFail(documents.bootstrap, "bootstrap", failures);
  const rpc = recordOrFail(documents.rpc, "rpc", failures);
  const miner = recordOrFail(documents.minerProfile, "miner-profile", failures);
  const authorization = recordOrFail(documents.authorization, "launch-authorization", failures);
  let chainIdNull = false;
  let genesisUnpublished = false;
  let bootstrapPlaceholder = false;
  let publicRpcInactive = false;
  let activationFlagsFalse = false;
  let minerProfileInactive = false;

  if (identity) {
    chainIdNull = identity.status === "proposal-unfilled" && identity.chainId === null && identity.genesisHash === null;
    genesisUnpublished = identity.genesisHash === null && identity.genesisTimestampMs === null;
    if (!chainIdNull) failures.push("identity-chain-id-published");
    if (identity.activationAllowed !== false || identity.publicMiningActivated !== false || identity.publicationAllowed !== false) {
      failures.push("identity-activation-flag");
    }
    if (!Array.isArray(identity.bootstrapPeers) || identity.bootstrapPeers.length !== 0) failures.push("identity-bootstrap-published");
    if (!Array.isArray(identity.publicRpcEndpoints) || identity.publicRpcEndpoints.length !== 0) failures.push("identity-rpc-published");
  }
  if (bootstrap) {
    bootstrapPlaceholder = bootstrap.live === false && bootstrap.status === "proposal-unfilled" && placeholderSlots(bootstrap.slots);
    if (!bootstrapPlaceholder) failures.push("bootstrap-not-placeholder");
    if (bootstrap.environmentIgnored !== true) failures.push("bootstrap-environment-not-ignored");
  }
  if (rpc) {
    const publicRole = isRecord(rpc.publicRole) ? rpc.publicRole : undefined;
    publicRpcInactive = rpc.live === false && rpc.status === "proposal-unfilled" && publicRole?.enabled === false &&
      Array.isArray(publicRole.origins) && publicRole.origins.every((origin) => origin === "PLACEHOLDER");
    if (!publicRpcInactive) failures.push("public-rpc-active");
  }
  if (miner) {
    minerProfileInactive = miner.schemaVersion === 1 && miner.publicMiningActivated === false &&
      miner.chainId === null && miner.genesisFile === null && miner.rpcUrl === null;
    if (!minerProfileInactive) failures.push("miner-profile-active");
  }
  if (authorization) {
    activationFlagsFalse = authorization.publicTestnetActivationAllowed === false && authorization.mainnetActivationAllowed === false;
    if (!activationFlagsFalse) failures.push("launch-authorization-activation-flag");
    if (!Array.isArray(authorization.publicTestnetActivationRequirements) ||
        authorization.publicTestnetActivationRequirements.length !== PUBLIC_TESTNET_ACTIVATION_REQUIREMENT_COUNT) {
      failures.push("activation-requirement-count-changed");
    }
  }
  let candidate: CandidatePublicTestnetGovernance | undefined;
  try {
    const example = parsePublicTestnetGovernanceInput(documents.governanceExample);
    if (example.status !== "example-unfilled" || example.chainId !== null) failures.push("example-governance-is-not-an-example");
  } catch {
    failures.push("example-governance-schema");
  }
  try {
    const parsed = parsePublicTestnetGovernanceInput(documents.governanceCandidate);
    if (parsed.status !== "candidate-awaiting-operator-input") failures.push("candidate-governance-status");
    else candidate = parsed;
  } catch {
    failures.push("candidate-governance-schema");
  }
  if (candidate) {
    if (candidate.networkName !== PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME) failures.push("candidate-network-name");
    if (candidate.chainId !== PUBLIC_TESTNET_CANDIDATE_CHAIN_ID) failures.push("candidate-chain-id");
    if (candidate.genesisTimestampMs !== null) failures.push("candidate-timestamp-published");
    if (candidate.validators.length !== 0 || candidate.bootstrapPeers.length !== 0 || candidate.publicRpcOrigins.length !== 0) {
      failures.push("candidate-operator-sets-published");
    }
  }
  if (INITIAL_MINING_REWARD_ATOMS !== 625_000_000 || MINING_DIFFICULTY_BITS !== 20 ||
      MINING_ERA_TARGET_CLAIMS !== 4_000_000 || MINING_PROTOCOL_VERSION !== 5 ||
      MAX_SUPPLY_ATOMS !== 50_000_000 * ATOMS_PER_ZYN) {
    failures.push("mining-economics-drift");
  }
  const engineeringReadiness = failures.length === 0 ? "PASS" : "FAIL";
  const validatorCount = candidate?.validators.length ?? 0;
  const bootstrapCount = candidate?.bootstrapPeers.length ?? 0;
  const rpcCount = candidate?.publicRpcOrigins.length ?? 0;
  const archiveCount = candidate?.archiveEndpoints.length ?? 0;
  const monitoringCount = candidate?.monitoringEndpoints.length ?? 0;
  return {
    engineeringReadiness,
    governanceActivation: "BLOCKED",
    activationReadiness: "NOT READY FOR ACTIVATION",
    chainIdNull,
    genesisUnpublished,
    bootstrapPlaceholder,
    publicRpcInactive,
    activationFlagsFalse,
    minerProfileInactive,
    consensusChanged: false,
    miningEconomicsChanged: false,
    publicTestnetActivationRequirementsRemaining: PUBLIC_TESTNET_ACTIVATION_REQUIREMENT_COUNT,
    humanInputsRequired: HUMAN_INPUTS_REQUIRED,
    failures,
    networkIdentity: {
      networkName: PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME,
      chainId: PUBLIC_TESTNET_CANDIDATE_CHAIN_ID,
      candidateStatus: "candidate-awaiting-operator-input",
      publishedIdentityChainId: null,
      validators: `${validatorCount}/${PUBLIC_TESTNET_VALIDATOR_COUNT}`,
      bootstraps: `${bootstrapCount}/${PUBLIC_TESTNET_BOOTSTRAP_COUNT}`,
      publicRpc: `${rpcCount}/${PUBLIC_TESTNET_PUBLIC_RPC_COUNT}`,
      archive: `${archiveCount}/${PUBLIC_TESTNET_ARCHIVE_COUNT}`,
      monitoring: `${monitoringCount}/${PUBLIC_TESTNET_MONITORING_COUNT}`,
      regions: `0/${PUBLIC_TESTNET_REGION_COUNT}`,
      genesis: "NOT BUILT",
      mining: "INACTIVE",
      authorization: "BLOCKED",
      engineeringReadiness,
      deploymentReadiness: "NOT READY",
      activationReadiness: "NOT READY FOR ACTIVATION"
    }
  };
}

export function assessSoakEvidence(samples: readonly SoakSample[], duration: SoakDuration): { progress: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (samples.length < 2) reasons.push("soak-needs-at-least-two-samples");
  let previousHeight = -1;
  const hashes = new Map<number, string>();
  for (const sample of samples) {
    if (sample.duration !== duration) reasons.push("soak-duration-mismatch");
    if (sample.finalizedHeight < previousHeight) reasons.push("finalized-height-decreased");
    previousHeight = sample.finalizedHeight;
    const seen = hashes.get(sample.finalizedHeight);
    if (seen !== undefined && seen !== sample.tipHash) reasons.push("divergent-finalized-hash");
    hashes.set(sample.finalizedHeight, sample.tipHash);
  }
  if (samples.length >= 2) {
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    if (last.finalizedHeight <= first.finalizedHeight) reasons.push("finalized-height-did-not-advance");
    if (duration === "72h" || duration === "7d") {
      if (last.rssBytes > first.rssBytes * 8 && last.rssBytes - first.rssBytes > 50_000_000) reasons.push("process-rss-growth");
      if (last.dbBytes > first.dbBytes * 8 && last.dbBytes - first.dbBytes > 50_000_000) reasons.push("state-or-db-growth");
    }
    if (duration === "7d") {
      if (samples.every((sample) => sample.peerCount === 0)) reasons.push("peers-absent");
      const rpcGrowth = last.rpcErrors - first.rpcErrors;
      const heightGrowth = last.finalizedHeight - first.finalizedHeight;
      if (rpcGrowth > heightGrowth * 10 && rpcGrowth > 100) reasons.push("rpc-error-growth");
    }
  }
  return { progress: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function parseSoakEvidenceJson(value: unknown): SoakSample[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Soak evidence must be a non-empty array");
  return value.map((entry) => parseSoakSample(entry));
}

export function parseSoakEvidenceCsv(text: string): SoakSample[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");
  const header = lines[0];
  if (header !== SOAK_COLUMNS.join(",")) throw new Error("Unexpected soak CSV header");
  return lines.slice(1).map((line) => {
    const cells = line.split(",");
    if (cells.length !== SOAK_COLUMNS.length) throw new Error("Unexpected soak CSV width");
    const record: Record<string, string> = {};
    SOAK_COLUMNS.forEach((column, index) => {
      record[column] = cells[index] ?? "";
    });
    return parseSoakSample({
      ...record,
      observedAtMs: Number(record.observedAtMs),
      height: Number(record.height),
      finalizedHeight: Number(record.finalizedHeight),
      finalityLatencyMs: Number(record.finalityLatencyMs),
      validatorAvailable: Number(record.validatorAvailable),
      validatorExpected: Number(record.validatorExpected),
      peerCount: Number(record.peerCount),
      peerChurn: Number(record.peerChurn),
      rpcLatencyMs: Number(record.rpcLatencyMs),
      rpcErrors: Number(record.rpcErrors),
      miningClaimsAccepted: Number(record.miningClaimsAccepted),
      miningClaimsRejected: Number(record.miningClaimsRejected),
      miningClaimsStale: Number(record.miningClaimsStale),
      dbBytes: Number(record.dbBytes),
      stateBytes: Number(record.stateBytes),
      rssBytes: Number(record.rssBytes),
      cpuPercent: Number(record.cpuPercent),
      eventLoopDelayMs: Number(record.eventLoopDelayMs),
      restarts: Number(record.restarts),
      reconnects: Number(record.reconnects),
      syncLagBlocks: Number(record.syncLagBlocks)
    });
  });
}

export function assessFinalizedHashes(observations: readonly { height: number; hash: string }[]): { critical: boolean; reason?: string } {
  const seen = new Map<number, string>();
  for (const observation of observations) {
    const previous = seen.get(observation.height);
    if (previous !== undefined && previous !== observation.hash) {
      return { critical: true, reason: "divergent-finalized-hash" };
    }
    seen.set(observation.height, observation.hash);
  }
  return { critical: false };
}

export function reconcileMiningIssuance(input: {
  genesisSupplyAtoms: number;
  finalizedRewardsAtoms: readonly number[];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (INITIAL_MINING_REWARD_ATOMS !== 625_000_000) reasons.push("initial-reward-changed");
  if (MINING_DIFFICULTY_BITS !== 20) reasons.push("difficulty-changed");
  if (MINING_ERA_TARGET_CLAIMS !== 4_000_000) reasons.push("halving-interval-changed");
  if (MAX_SUPPLY_ATOMS !== 50_000_000 * ATOMS_PER_ZYN) reasons.push("supply-cap-changed");
  let issued = 0;
  input.finalizedRewardsAtoms.forEach((reward, index) => {
    const expected = miningRewardAtoms(index, input.genesisSupplyAtoms);
    if (reward !== expected) reasons.push(`reward-mismatch-${index}`);
    issued += reward;
  });
  if (input.finalizedRewardsAtoms.length > 0 && input.finalizedRewardsAtoms[0] !== INITIAL_MINING_REWARD_ATOMS) {
    reasons.push("first-reward-is-not-6.25-zyn");
  }
  const scheduled = cumulativeMiningIssuanceAtoms(input.finalizedRewardsAtoms.length, input.genesisSupplyAtoms);
  if (issued !== scheduled) reasons.push("issued-total-mismatch");
  if (input.genesisSupplyAtoms + issued > MAX_SUPPLY_ATOMS) reasons.push("supply-cap-exceeded");
  return { ok: reasons.length === 0, reasons };
}

export function reconcileMultiMinerCohort(input: {
  cohortSize: (typeof MINER_COHORT_SIZES)[number];
  genesisSupplyAtoms: number;
  miners: readonly { accepted: number; rejected: number; stale: number; duplicate: number }[];
  finalizedRewardsAtoms: readonly number[];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!MINER_COHORT_SIZES.includes(input.cohortSize)) reasons.push("unsupported-cohort");
  if (input.miners.length !== input.cohortSize) reasons.push("cohort-size-mismatch");
  const accepted = input.miners.reduce((sum, miner) => sum + miner.accepted, 0);
  if (accepted !== input.finalizedRewardsAtoms.length) reasons.push("accepted-claims-do-not-match-finalized-rewards");
  const issuance = reconcileMiningIssuance({
    genesisSupplyAtoms: input.genesisSupplyAtoms,
    finalizedRewardsAtoms: input.finalizedRewardsAtoms
  });
  reasons.push(...issuance.reasons);
  return { ok: reasons.length === 0, reasons };
}

export function assertPublicTestnetChainId(chainId: unknown): asserts chainId is string {
  if (typeof chainId !== "string" || chainId.length > 64 || !CHAIN_ID_PATTERN.test(chainId) || containsBannedLiveToken(chainId)) {
    throw new Error("Invalid public-testnet chain ID");
  }
  if (chainId.includes("mainnet") || chainId.includes("devnet") || chainId.includes("local")) {
    throw new Error("Public-testnet chain ID cannot be a mainnet or local-devnet identifier");
  }
}

export function assertChainIdAllowedForClass(chainId: string, networkClass: "public-testnet" | "mainnet" | "local-devnet"): void {
  if (networkClass === "mainnet") {
    throw new Error("Mainnet must not use a public-testnet chain ID or be derived from public-testnet identity");
  }
  if (networkClass === "local-devnet") {
    if (CHAIN_ID_PATTERN.test(chainId)) throw new Error("Local-devnet cannot use a public-testnet chain ID");
    return;
  }
  assertPublicTestnetChainId(chainId);
}

export function publicTestnetAllocationReport(allocations: readonly { amountAtoms: number }[]): {
  humanInputsRequired: readonly string[];
  genesisSupplyAtoms: number;
  miningBudgetAtoms: number;
  maxSupplyAtoms: number;
} {
  const genesisSupplyAtoms = allocations.reduce((sum, allocation) => sum + allocation.amountAtoms, 0);
  if (genesisSupplyAtoms > MAX_SUPPLY_ATOMS) throw new Error("Allocations exceed the mining supply cap");
  return {
    humanInputsRequired: allocations.length === 0 ? ALLOCATION_HUMAN_INPUTS : [],
    genesisSupplyAtoms,
    miningBudgetAtoms: MAX_SUPPLY_ATOMS - genesisSupplyAtoms,
    maxSupplyAtoms: MAX_SUPPLY_ATOMS
  };
}

function isAcceptableNetworkName(value: unknown): value is string {
  return typeof value === "string" && !containsBannedLiveToken(value) &&
    (NETWORK_NAME_PATTERN.test(value) || DISPLAY_NAME_PATTERN.test(value));
}

function parseCandidateGovernance(value: Record<string, unknown>): CandidatePublicTestnetGovernance {
  if (!isAcceptableNetworkName(value.networkName)) throw new Error("Invalid public-testnet network name");
  assertPublicTestnetChainId(value.chainId);
  if (value.genesisTimestampMs !== null || value.activityPool !== null) {
    throw new Error("Candidate governance must keep the genesis timestamp and activity pool empty");
  }
  for (const key of ["validators", "activityOracles", "allocations", "bootstrapPeers", "publicRpcOrigins", "archiveEndpoints", "monitoringEndpoints"] as const) {
    if (!Array.isArray(value[key]) || value[key].length !== 0) throw new Error("Candidate governance must not publish operator sets");
  }
  return {
    schemaVersion: 1,
    status: "candidate-awaiting-operator-input",
    networkName: value.networkName,
    chainId: value.chainId,
    genesisVersion: 1,
    genesisTimestampMs: null,
    initialProtocolVersion: 1,
    protocolV5ActivationPolicy: PUBLIC_TESTNET_V5_ACTIVATION_POLICY,
    validators: [],
    activityOracles: [],
    activityPool: null,
    allocations: [],
    bootstrapPeers: [],
    publicRpcOrigins: [],
    archiveEndpoints: [],
    monitoringEndpoints: []
  };
}

function candidateOperatorGaps(): string[] {
  return [
    "genesisTimestampMs",
    "validators",
    "activityOracles",
    "activityPool",
    "allocations",
    "bootstrapPeers",
    "publicRpcOrigins",
    "archiveEndpoints",
    "monitoringEndpoints"
  ];
}

function parseExampleGovernance(value: Record<string, unknown>): ExamplePublicTestnetGovernance {
  if (typeof value.networkName !== "string" || value.chainId !== null || value.genesisTimestampMs !== null || value.activityPool !== null) {
    throw new Error("Example governance must keep chain ID, timestamp, and activity pool empty");
  }
  for (const key of ["validators", "activityOracles", "allocations", "bootstrapPeers", "publicRpcOrigins", "archiveEndpoints", "monitoringEndpoints"] as const) {
    if (!Array.isArray(value[key]) || value[key].length !== 0) throw new Error("Example governance must not publish live sets");
  }
  return {
    schemaVersion: 1,
    status: "example-unfilled",
    networkName: value.networkName,
    chainId: null,
    genesisVersion: 1,
    genesisTimestampMs: null,
    initialProtocolVersion: 1,
    protocolV5ActivationPolicy: PUBLIC_TESTNET_V5_ACTIVATION_POLICY,
    validators: [],
    activityOracles: [],
    activityPool: null,
    allocations: [],
    bootstrapPeers: [],
    publicRpcOrigins: [],
    archiveEndpoints: [],
    monitoringEndpoints: []
  };
}

function parseApprovedGovernance(value: Record<string, unknown>): ApprovedPublicTestnetGovernance {
  if (!isAcceptableNetworkName(value.networkName)) throw new Error("Invalid public-testnet network name");
  try {
    assertPublicTestnetChainId(value.chainId);
  } catch (error) {
    throw new Error(`Approved public-testnet chain ID must be an explicit zyron-public-testnet label: ${(error as Error).message}`);
  }
  if (!Number.isSafeInteger(value.genesisTimestampMs) || Number(value.genesisTimestampMs) < 0) {
    throw new Error("Approved governance requires an explicit genesis timestamp");
  }
  const validators = parseValidators(value.validators);
  const activityOracles = parseOracleKeys(value.activityOracles);
  if (typeof value.activityPool !== "string" || !/^ZYN[0-9a-f]{40}$/.test(value.activityPool)) {
    throw new Error("Approved governance requires an activity pool address");
  }
  const allocations = parseAllocations(value.allocations, value.activityPool as Address);
  const bootstrapPeers = parseBootstrapPeers(value.bootstrapPeers);
  const deployment = inspectBootstrapDeployment(bootstrapPeers);
  if (deployment.errors.length > 0) throw new Error(`Bootstrap deployment refused: ${deployment.errors.join(",")}`);
  const publicRpcOrigins = parseOriginList(value.publicRpcOrigins, "public RPC origin", 2);
  const archiveEndpoints = parseOriginList(value.archiveEndpoints, "archive endpoint", 1);
  const monitoringEndpoints = parseOriginList(value.monitoringEndpoints, "monitoring endpoint", 1);
  const approved: ApprovedPublicTestnetGovernance = {
    schemaVersion: 1,
    status: "governance-approved",
    networkName: value.networkName,
    chainId: value.chainId,
    genesisVersion: 1,
    genesisTimestampMs: Number(value.genesisTimestampMs),
    initialProtocolVersion: 1,
    protocolV5ActivationPolicy: PUBLIC_TESTNET_V5_ACTIVATION_POLICY,
    validators,
    activityOracles,
    activityPool: value.activityPool as Address,
    allocations,
    bootstrapPeers,
    publicRpcOrigins,
    archiveEndpoints,
    monitoringEndpoints
  };
  parsePublicTestnetIdentity({
    schemaVersion: 1,
    status: "identity-frozen",
    networkClass: "public-testnet",
    chainId: approved.chainId,
    genesisHash: "11".repeat(32),
    genesisTimestampMs: approved.genesisTimestampMs,
    bootstrapPeers: approved.bootstrapPeers,
    publicRpcEndpoints: approved.publicRpcOrigins,
    activationAllowed: false,
    publicMiningActivated: false,
    publicationAllowed: false
  });
  return approved;
}

function parseValidators(value: unknown): PublicTestnetGovernanceValidator[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new Error("Approved governance requires 1 to 100 validators");
  const seen = new Set<string>();
  const validators: PublicTestnetGovernanceValidator[] = [];
  for (const entry of value) {
    assertPlainRecord(entry, "governance validator");
    assertExactKeys(entry, VALIDATOR_KEYS, "governance validator");
    if (typeof entry.publicKey !== "string" || !/^[0-9a-f]{128}$/.test(entry.publicKey)) throw new Error("Invalid governance validator public key");
    if (entry.weight !== 1) throw new Error("Validator weights are not a consensus feature");
    if (containsBannedLiveToken(entry.publicKey)) throw new Error("Invalid governance validator public key");
    if (seen.has(entry.publicKey)) throw new Error("Duplicate governance validator");
    seen.add(entry.publicKey);
    validators.push({ publicKey: entry.publicKey, weight: 1 });
  }
  return validators;
}

function parseOracleKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Approved governance requires an activity oracle public key");
  const seen = new Set<string>();
  const oracles: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !/^[0-9a-f]{128}$/.test(entry)) throw new Error("Invalid activity oracle public key");
    if (seen.has(entry)) throw new Error("Duplicate activity oracle");
    seen.add(entry);
    oracles.push(entry);
  }
  return oracles;
}

function parseAllocations(value: unknown, activityPool: Address): PublicTestnetGovernanceAllocation[] {
  if (!Array.isArray(value) || value.length < 1) throw new Error("Approved governance requires explicit allocations");
  const allocations: PublicTestnetGovernanceAllocation[] = [];
  for (const entry of value) {
    assertPlainRecord(entry, "governance allocation");
    assertExactKeys(entry, ALLOCATION_KEYS, "governance allocation");
    if (typeof entry.purpose !== "string" || REJECTED_ALLOCATION_PURPOSES.has(entry.purpose)) {
      throw new Error("Founder, premine, and team allocations are rejected, including hidden, admin, and emergency mint");
    }
    if (!ALLOCATION_PURPOSES.has(entry.purpose)) throw new Error("Invalid allocation purpose");
    if (typeof entry.address !== "string" || !/^ZYN[0-9a-f]{40}$/.test(entry.address)) throw new Error("Invalid allocation address");
    if (!Number.isSafeInteger(entry.amountAtoms) || Number(entry.amountAtoms) < 0) throw new Error("Invalid allocation amount");
    if (entry.purpose === "activity-pool" && entry.address !== activityPool) throw new Error("Activity-pool allocation address mismatch");
    allocations.push({
      address: entry.address as Address,
      amountAtoms: Number(entry.amountAtoms),
      purpose: entry.purpose as PublicTestnetGovernanceAllocation["purpose"]
    });
  }
  return allocations;
}

function parseBootstrapPeers(value: unknown): PublicTestnetGovernanceBootstrap[] {
  if (!Array.isArray(value)) throw new Error("Approved governance requires bootstrap peers");
  const peers: PublicTestnetGovernanceBootstrap[] = [];
  for (const entry of value) {
    assertPlainRecord(entry, "governance bootstrap");
    assertExactKeys(entry, BOOTSTRAP_KEYS, "governance bootstrap");
    if (typeof entry.peerId !== "string" || typeof entry.multiaddr !== "string" || typeof entry.failureDomain !== "string") {
      throw new Error("Bootstrap peer ID, multiaddr, and failure domain are required");
    }
    if (containsBannedLiveToken(entry.peerId) || containsBannedLiveToken(entry.multiaddr) || containsBannedLiveToken(entry.failureDomain)) {
      throw new Error("Bootstrap identity contains a placeholder or local endpoint");
    }
    peers.push({ peerId: entry.peerId, multiaddr: entry.multiaddr, failureDomain: entry.failureDomain });
  }
  return peers;
}

function parseOriginList(value: unknown, name: string, minimum: number): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > 8) throw new Error(`Invalid ${name} list`);
  const origins: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error(`Invalid ${name}`);
    if (containsBannedLiveToken(entry)) throw new Error(`${name} contains a placeholder or local endpoint`);
    const origin = assertPublicHttpsOrigin(entry);
    if (seen.has(origin)) throw new Error(`Duplicate ${name}`);
    seen.add(origin);
    origins.push(origin);
  }
  return origins;
}

function assertPublicHttpsOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid public HTTPS origin");
  }
  if (url.protocol !== "https:") throw new Error("Public origin must use HTTPS");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Public origin must not include credentials, a path, a query, or a fragment");
  }
  const hostname = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  if (containsBannedLiveToken(hostname) || isLoopbackRpcHost(hostname)) throw new Error("Public origin is local or a placeholder");
  const family = isIP(hostname);
  if (family === 4 || family === 6) {
    if (!isGloballyReachableIp(hostname, family === 4 ? "ipv4" : "ipv6")) throw new Error("Public origin uses a non-public IP");
  } else if (!DNS_NAME_PATTERN.test(hostname) || RESERVED_DNS_SUFFIXES.has(hostname.split(".").at(-1) ?? "")) {
    throw new Error("Public origin DNS name is not acceptable");
  }
  return url.origin;
}

function containsBannedLiveToken(value: string): boolean {
  const lower = value.toLowerCase();
  return lower.trim() === "" || BANNED_LIVE_TOKENS.some((token) => lower.includes(token));
}

function normalizeApproved(input: ApprovedPublicTestnetGovernance): ApprovedPublicTestnetGovernance {
  return {
    ...input,
    validators: [...input.validators].sort((left, right) => left.publicKey.localeCompare(right.publicKey)),
    activityOracles: [...input.activityOracles].sort((left, right) => left.localeCompare(right)),
    allocations: [...input.allocations].sort((left, right) => left.address.localeCompare(right.address)),
    bootstrapPeers: [...input.bootstrapPeers].sort((left, right) => left.peerId.localeCompare(right.peerId)),
    publicRpcOrigins: [...input.publicRpcOrigins].sort((left, right) => left.localeCompare(right)),
    archiveEndpoints: [...input.archiveEndpoints].sort((left, right) => left.localeCompare(right)),
    monitoringEndpoints: [...input.monitoringEndpoints].sort((left, right) => left.localeCompare(right))
  };
}

function parseSoakSample(value: unknown): SoakSample {
  assertPlainRecord(value, "soak sample");
  assertExactKeys(value, SOAK_COLUMNS, "soak sample");
  if (value.duration !== "24h" && value.duration !== "72h" && value.duration !== "7d") throw new Error("Invalid soak duration");
  const numbers = [
    "observedAtMs", "height", "finalizedHeight", "finalityLatencyMs", "validatorAvailable", "validatorExpected",
    "peerCount", "peerChurn", "rpcLatencyMs", "rpcErrors", "miningClaimsAccepted", "miningClaimsRejected",
    "miningClaimsStale", "dbBytes", "stateBytes", "rssBytes", "cpuPercent", "eventLoopDelayMs", "restarts",
    "reconnects", "syncLagBlocks"
  ] as const;
  for (const key of numbers) {
    if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) throw new Error(`Invalid soak ${key}`);
  }
  if (typeof value.tipHash !== "string" || !/^[0-9a-f]{64}$/.test(value.tipHash)) throw new Error("Invalid soak tip hash");
  return value as unknown as SoakSample;
}

function placeholderSlots(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== 3) return false;
  return value.every((slot) => isRecord(slot) && slot.failureDomain === "PLACEHOLDER" && slot.peerId === "PLACEHOLDER" && slot.multiaddr === "PLACEHOLDER");
}

function recordOrFail(value: unknown, name: string, failures: string[]): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    failures.push(`${name}-not-object`);
    return undefined;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
