import { generatePrivateKey, publicKeyFromPrivate, addressFromPublicKey } from "./crypto.js";
import { MIN_PROTOCOL_UPDATE_DELAY } from "./chain.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";
import { miningRewardAtoms } from "./mining.js";
import { validatorQuorumSize } from "./block.js";
import {
  CRITICAL_ALERTS,
  MINER_COHORT_SIZES,
  PUBLIC_TESTNET_CANDIDATE_CHAIN_ID,
  PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME,
  PUBLIC_TESTNET_METRICS,
  PUBLIC_TESTNET_V5_ACTIVATION_POLICY,
  reconcileMiningIssuance,
  reconcileMultiMinerCohort
} from "./public-testnet-governance.js";

export const CPU_PROFILES = {
  low: { iterations: 1_000, hardwareBenchmark: false as const, note: "NOT a real hardware benchmark" },
  medium: { iterations: 5_000, hardwareBenchmark: false as const, note: "NOT a real hardware benchmark" },
  high: { iterations: 20_000, hardwareBenchmark: false as const, note: "NOT a real hardware benchmark" },
  "very-high": { iterations: 50_000, hardwareBenchmark: false as const, note: "NOT a real hardware benchmark" }
} as const;

export type CpuProfileName = keyof typeof CPU_PROFILES;

export const WORKLOAD_SCENARIOS = [
  "ramp",
  "drop",
  "reconnect",
  "rpc-outage",
  "bootstrap-outage",
  "validator-outage",
  "crash-restart",
  "latency-loss",
  "stale-tip",
  "simultaneous-claims",
  "duplicate-claims",
  "wrong-chain",
  "wrong-genesis"
] as const;

export const REHEARSAL_TOPOLOGY = {
  validators: 3,
  bootstraps: 3,
  publicRpc: 2,
  archive: 1,
  monitoring: 1,
  regions: ["region-a", "region-b", "region-c"],
  publicConsensus: false,
  publicMiningActivated: false
} as const;

export const REHEARSAL_SCENARIOS = [
  "startup",
  "discovery",
  "consensus",
  "finality",
  "rpc",
  "restart",
  "sync",
  "outage",
  "failover",
  "wrong-identity",
  "wrong-genesis",
  "fresh-sync",
  "checkpoint-sync"
] as const;

export function shapeCpuProfile(name: CpuProfileName): { profile: CpuProfileName; hardwareBenchmark: false; iterations: number } {
  const profile = CPU_PROFILES[name];
  let sink = 0;
  const bound = Math.min(profile.iterations, 64);
  for (let index = 0; index < bound; index += 1) sink = (sink + index) % 997;
  if (sink < 0) throw new Error("CPU profile shaping failed");
  return { profile: name, hardwareBenchmark: false, iterations: profile.iterations };
}

export function createMinerCohort(size: (typeof MINER_COHORT_SIZES)[number]): { address: string }[] {
  if (!MINER_COHORT_SIZES.includes(size)) throw new Error("Unsupported miner cohort");
  const wallets: { address: string }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < size; index += 1) {
    const privateKey = generatePrivateKey();
    const address = addressFromPublicKey(publicKeyFromPrivate(privateKey));
    if (seen.has(address)) throw new Error("Miner cohort address collision");
    seen.add(address);
    wallets.push({ address });
  }
  return wallets;
}

export function runMinerWorkload(input: {
  cohortSize: (typeof MINER_COHORT_SIZES)[number];
  scenario: (typeof WORKLOAD_SCENARIOS)[number];
  genesisSupplyAtoms: number;
  profile: CpuProfileName;
  chainId: string;
  genesisHash: string;
  observedRewardsAtoms?: readonly number[];
}): { critical: boolean; reasons: string[]; accepted: number; supplyAtoms: number } {
  const reasons: string[] = [];
  const shaped = shapeCpuProfile(input.profile);
  if (shaped.hardwareBenchmark !== false) reasons.push("cpu-profile-claimed-hardware");
  if (input.chainId !== PUBLIC_TESTNET_CANDIDATE_CHAIN_ID && input.scenario !== "wrong-chain") {
    reasons.push("workload-chain-id");
  }
  const cohort = createMinerCohort(input.cohortSize);
  if (cohort.length !== input.cohortSize) reasons.push("cohort-size-mismatch");
  const claimCount = input.scenario === "drop" ? 0 : Math.min(4, input.cohortSize);
  let accepted = claimCount;
  let duplicate = 0;
  let rejected = 0;
  let stale = 0;
  if (input.scenario === "duplicate-claims" || input.scenario === "simultaneous-claims") {
    duplicate = 1;
    accepted = Math.max(0, claimCount - 1);
  }
  if (input.scenario === "stale-tip" || input.scenario === "latency-loss") stale = 1;
  if (input.scenario === "wrong-chain" || input.scenario === "wrong-genesis") {
    accepted = 0;
    rejected = claimCount;
    reasons.push(input.scenario === "wrong-chain" ? "wrong-chain-rejected" : "wrong-genesis-rejected");
  }
  if (input.scenario === "rpc-outage" || input.scenario === "bootstrap-outage" || input.scenario === "validator-outage") {
    accepted = Math.max(0, claimCount - 1);
    rejected += 1;
  }
  const rewards = input.observedRewardsAtoms
    ? [...input.observedRewardsAtoms]
    : Array.from({ length: accepted }, (_, index) => miningRewardAtoms(index, input.genesisSupplyAtoms));
  const miners = cohort.map((_, index) => ({
    accepted: index === 0 ? accepted : 0,
    rejected: index === 0 ? rejected : 0,
    stale: index === 0 ? stale : 0,
    duplicate: index === 0 ? duplicate : 0
  }));
  const reconciled = reconcileMultiMinerCohort({
    cohortSize: input.cohortSize,
    genesisSupplyAtoms: input.genesisSupplyAtoms,
    miners,
    finalizedRewardsAtoms: rewards
  });
  if (!reconciled.ok) reasons.push("CRITICAL FAIL", ...reconciled.reasons);
  const issuance = reconcileMiningIssuance({ genesisSupplyAtoms: input.genesisSupplyAtoms, finalizedRewardsAtoms: rewards });
  if (!issuance.ok) reasons.push("CRITICAL FAIL", ...issuance.reasons);
  const supplyAtoms = input.genesisSupplyAtoms + rewards.reduce((sum, reward) => sum + reward, 0);
  if (supplyAtoms > MAX_SUPPLY_ATOMS) reasons.push("CRITICAL FAIL", "supply-cap-exceeded");
  if (input.genesisHash.length !== 64) reasons.push("genesis-hash");
  return {
    critical: reasons.includes("CRITICAL FAIL"),
    reasons: [...new Set(reasons)],
    accepted,
    supplyAtoms
  };
}

export function assessProtocolV5Rehearsal(input: {
  genesisProtocolVersion: number;
  proposalHeight: number;
  activationHeight: number;
  approvals: number;
  validatorCount: number;
  publicMiningActivated: boolean;
  delayBypassed: boolean;
  activationPolicy: string;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.genesisProtocolVersion !== 1) reasons.push("genesis-protocol-must-stay-v1");
  if (input.activationPolicy !== PUBLIC_TESTNET_V5_ACTIVATION_POLICY) reasons.push("activation-policy");
  if (input.delayBypassed) reasons.push("delay-bypassed");
  if (input.activationHeight < input.proposalHeight + MIN_PROTOCOL_UPDATE_DELAY) reasons.push("activation-too-soon");
  if (input.approvals < validatorQuorumSize(input.validatorCount)) reasons.push("approval-quorum");
  if (input.publicMiningActivated) reasons.push("public-mining-activated");
  return { ok: reasons.length === 0, reasons };
}

export function assessRehearsalTopology(value: {
  validators: number;
  bootstraps: number;
  publicRpc: number;
  archive: number;
  monitoring: number;
  regions: readonly string[];
  publicConsensus: boolean;
  scenarios: readonly string[];
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (value.validators !== REHEARSAL_TOPOLOGY.validators) reasons.push("validators");
  if (value.bootstraps !== REHEARSAL_TOPOLOGY.bootstraps) reasons.push("bootstraps");
  if (value.publicRpc < REHEARSAL_TOPOLOGY.publicRpc) reasons.push("public-rpc");
  if (value.archive !== REHEARSAL_TOPOLOGY.archive) reasons.push("archive");
  if (value.monitoring !== REHEARSAL_TOPOLOGY.monitoring) reasons.push("monitoring");
  if (value.regions.length !== 3 || new Set(value.regions).size !== 3) reasons.push("regions");
  if (value.publicConsensus) reasons.push("consensus-exposed");
  for (const scenario of REHEARSAL_SCENARIOS) {
    if (!value.scenarios.includes(scenario)) reasons.push(`missing-${scenario}`);
  }
  return { ok: reasons.length === 0, reasons };
}

export function renderPublicTestnetMetrics(snapshot: {
  finalizedHeight: number;
  finalityLatencyMs: number;
  peerCount: number;
  rpcRequests: number;
  rpcErrors: number;
  rpcLatencyMs: number;
  validatorUp: number;
  validatorSigningFailures: number;
  miningClaimsAccepted: number;
  miningClaimsRejected: number;
  miningClaimsStale: number;
  stateBytes: number;
  dbBytes: number;
  processRssBytes: number;
  processUptimeSeconds: number;
  exposure: "operator" | "public";
}): string {
  if (snapshot.exposure !== "operator") throw new Error("Metrics must not be exposed on the public internet");
  const values: Record<(typeof PUBLIC_TESTNET_METRICS)[number], number> = {
    zyron_finalized_height: snapshot.finalizedHeight,
    zyron_finality_latency_ms: snapshot.finalityLatencyMs,
    zyron_peer_count: snapshot.peerCount,
    zyron_rpc_requests: snapshot.rpcRequests,
    zyron_rpc_errors: snapshot.rpcErrors,
    zyron_rpc_latency_ms: snapshot.rpcLatencyMs,
    zyron_validator_up: snapshot.validatorUp,
    zyron_validator_signing_failures: snapshot.validatorSigningFailures,
    zyron_mining_claims_accepted: snapshot.miningClaimsAccepted,
    zyron_mining_claims_rejected: snapshot.miningClaimsRejected,
    zyron_mining_claims_stale: snapshot.miningClaimsStale,
    zyron_state_bytes: snapshot.stateBytes,
    zyron_db_bytes: snapshot.dbBytes,
    zyron_process_rss_bytes: snapshot.processRssBytes,
    zyron_process_uptime_seconds: snapshot.processUptimeSeconds
  };
  return PUBLIC_TESTNET_METRICS.map((name) => `${name} ${values[name]}`).join("\n") + "\n";
}

export function criticalAlertNames(): readonly string[] {
  return CRITICAL_ALERTS;
}

const FREEZE_KEYS = [
  "schemaVersion", "status", "networkName", "chainId", "genesisHash", "genesisSha256",
  "genesisTimestampMs", "validatorSetHash", "configurationHash", "commit"
] as const;

export function parsePublicTestnetFreezeFormat(value: unknown): { official: false; status: "format-only" } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid freeze manifest");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...FREEZE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Invalid freeze manifest fields");
  }
  if (record.schemaVersion !== 1 || record.status !== "format-only") {
    throw new Error("Official public-testnet freeze is refused until a real genesis exists");
  }
  for (const key of ["networkName", "chainId", "genesisHash", "genesisSha256", "genesisTimestampMs", "validatorSetHash", "configurationHash", "commit"] as const) {
    if (record[key] !== null) throw new Error("Freeze format must keep genesis fields empty");
  }
  if (record.networkName === PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME) {
    throw new Error("Freeze format must keep genesis fields empty");
  }
  return { official: false, status: "format-only" };
}

export function assessReleaseArtifactPlan(plan: {
  targets: readonly string[];
  sha256sums: boolean;
  sbom: boolean;
  commit: string | null;
  provenance: boolean;
  publicationAllowed: boolean;
  publishRequested: boolean;
}): { readyToPublish: false; reasons: string[] } {
  const reasons: string[] = [];
  for (const target of ["linux", "darwin", "windows"]) {
    if (!plan.targets.includes(target)) reasons.push(`missing-target-${target}`);
  }
  if (!plan.sha256sums) reasons.push("missing-sha256sums");
  if (!plan.sbom) reasons.push("missing-sbom");
  if (!plan.commit) reasons.push("missing-commit");
  if (!plan.provenance) reasons.push("missing-provenance");
  if (plan.publicationAllowed) reasons.push("publication-allowed");
  if (plan.publishRequested) reasons.push("publish-requested");
  reasons.push("publication-blocked");
  return { readyToPublish: false, reasons };
}

export function assertRollbackAction(action: string): void {
  const denied = new Set([
    "delete-signing-journal",
    "regenerate-genesis",
    "reuse-chain-id-with-different-genesis"
  ]);
  if (denied.has(action)) throw new Error(`Rollback refuses ${action}`);
  if (action !== "restart-from-existing-data-directory") {
    throw new Error("Unknown rollback action");
  }
}

export function assertOperatorDomain(hostname: string): void {
  const lower = hostname.toLowerCase();
  if (lower.includes("placeholder") || lower.includes("changeme") || lower.includes("example.com") ||
      lower.includes("localhost") || lower === "127.0.0.1" || lower === "::1") {
    throw new Error("Operator domain is not a live public name");
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(lower)) {
    throw new Error("Operator domain is not a DNS name");
  }
  const suffix = lower.split(".").at(-1) ?? "";
  if (["local", "localhost", "internal", "lan", "home", "arpa", "invalid", "test", "example", "onion"].includes(suffix)) {
    throw new Error("Operator domain uses a reserved suffix");
  }
}

export function freezeFormatDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: "format-only",
    networkName: null,
    chainId: null,
    genesisHash: null,
    genesisSha256: null,
    genesisTimestampMs: null,
    validatorSetHash: null,
    configurationHash: null,
    commit: null
  };
}

export const RELEASE_PIPELINE = {
  status: "prepared-not-published",
  publicationAllowed: false,
  publish: false,
  targets: ["linux", "darwin", "windows"],
  artifacts: ["SHA256SUMS", "SBOM", "commit", "provenance"],
  networkName: PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME,
  chainId: PUBLIC_TESTNET_CANDIDATE_CHAIN_ID
} as const;
