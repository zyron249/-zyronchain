import { isIP } from "node:net";

import { isGloballyReachableIp } from "./p2p-peer-pool.js";
import {
  INITIAL_MINING_REWARD_ATOMS,
  MINING_DIFFICULTY_BITS,
  meetsMiningDifficulty,
  miningRewardAtoms,
  miningWorkHash,
  type MiningWorkFields
} from "./mining.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "./types.js";
import {
  PUBLIC_TESTNET_CANDIDATE_CHAIN_ID,
  PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME,
  inspectBootstrapDeployment,
  type PublicTestnetPreflightReport
} from "./public-testnet-governance.js";

export const OPERATOR_STATUS_LABEL = "AWAITING REAL OPERATOR INPUT";

export const STOP_SHIP_DOUBLE_HASH_REVIEW =
  "STOP-SHIP REVIEW: a round-0 split where two hashes could both still reach quorum stays stuck. Quorum and the reveal threshold stay unchanged.";

export const SOAK_HORIZON_MS = {
  "24h": 86_400_000,
  "72h": 259_200_000,
  "7d": 604_800_000
} as const;

export interface PlacementHost {
  id: string;
  region: string;
  roles: string[];
  optional?: boolean;
}

const REGION_A_ROLES = ["validator-a", "bootstrap-a", "monitoring-replica"] as const;
const REGION_B_ROLES = ["validator-b", "bootstrap-b", "rpc-a", "archive-a"] as const;
const REGION_C_ROLES = ["validator-c", "bootstrap-c", "rpc-b", "monitoring-primary"] as const;

export function assertHostPlacement(hosts: readonly PlacementHost[]): void {
  if (hosts.length < 10) throw new Error("Public-testnet placement is missing required hosts");
  const seenRoles = new Set<string>();
  for (const host of hosts) {
    if (host.roles.length !== 1) throw new Error("One VM must not combine public-testnet roles");
    const role = host.roles[0];
    if (!role || seenRoles.has(role)) throw new Error("Duplicate or empty role placement");
    seenRoles.add(role);
    if (!["region-a", "region-b", "region-c"].includes(host.region)) throw new Error("Unknown placement region");
  }
  const regionOf = (role: string): string => {
    const host = hosts.find((item) => item.roles[0] === role);
    if (!host) throw new Error(`Missing role ${role}`);
    return host.region;
  };
  for (const role of ["validator-a", "validator-b", "validator-c", "bootstrap-a", "bootstrap-b", "bootstrap-c", "rpc-a", "rpc-b", "archive-a", "monitoring-primary"]) {
    regionOf(role);
  }
  if (new Set(["validator-a", "validator-b", "validator-c"].map(regionOf)).size !== 3) {
    throw new Error("Validators must span three regions");
  }
  if (new Set(["bootstrap-a", "bootstrap-b", "bootstrap-c"].map(regionOf)).size !== 3) {
    throw new Error("Bootstraps must span three regions");
  }
  if (regionOf("rpc-a") === regionOf("rpc-b")) throw new Error("Public RPC endpoints must not share one region");
  for (const role of REGION_A_ROLES) {
    if (seenRoles.has(role) && regionOf(role) !== "region-a") throw new Error("Region A placement drifted");
  }
  for (const role of REGION_B_ROLES) {
    if (regionOf(role) !== "region-b") throw new Error("Region B placement drifted");
  }
  for (const role of REGION_C_ROLES) {
    if (regionOf(role) !== "region-c") throw new Error("Region C placement drifted");
  }
  const kinds = hosts.map((host) => host.roles[0] ?? "");
  if (kinds.filter((role) => role.startsWith("validator-")).length < 3) throw new Error("Validator placement is incomplete");
}

export function assertRealBootstrapSet(peers: readonly { peerId: string; multiaddr: string; failureDomain: string }[]): void {
  if (peers.length !== 3) throw new Error("Bootstrap deployment requires 3 peers");
  const inspection = inspectBootstrapDeployment(peers);
  if (inspection.errors.includes("duplicate-bootstrap-peer-id")) throw new Error("Duplicate bootstrap peer ID");
  if (inspection.errors.includes("failure-domain-repeated-three-times") || inspection.errors.includes("bootstrap-failure-domains-below-3")) {
    throw new Error("Bootstrap peers must use three failure domains");
  }
  if (inspection.errors.length > 0) throw new Error(`Bootstrap deployment refused: ${inspection.errors.join(",")}`);
  for (const peer of peers) {
    const lowered = `${peer.peerId} ${peer.multiaddr} ${peer.failureDomain}`.toLowerCase();
    if (lowered.includes("placeholder") || lowered.includes("changeme") || lowered.includes("example.com") || lowered.includes("localhost")) {
      throw new Error("Bootstrap identity is not a real operator value");
    }
    if (!peer.multiaddr.startsWith("/")) throw new Error("Bootstrap multiaddr is not real");
  }
}

export function validateOperatorHttpsOrigin(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Operator origin is not a URL");
  }
  if (url.protocol !== "https:") throw new Error("Operator origin must use HTTPS");
  if (url.username || url.password) throw new Error("Operator origin must not include credentials");
  if (url.search || url.hash) throw new Error("Operator origin must not include a query or fragment");
  if (url.pathname !== "/" && url.pathname !== "") throw new Error("Operator origin must not include a path");
  const host = url.hostname.startsWith("[") && url.hostname.endsWith("]") ? url.hostname.slice(1, -1) : url.hostname;
  const family = isIP(host);
  if (family === 4 || family === 6) {
    if (!isGloballyReachableIp(host, family === 4 ? "ipv4" : "ipv6")) {
      throw new Error("Operator origin uses a private or non-public address");
    }
    return;
  }
  const lower = host.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower === "example.com" || lower.endsWith(".example.com") || lower.includes("example.com")) {
    throw new Error("Operator origin is not a live public name");
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(lower)) {
    throw new Error("Operator origin is not a DNS name");
  }
}

const SECRET_KEYS = new Set(["privatekey", "password", "mnemonic", "ciphertext", "keystore", "secret"]);

export function assertNoSecretFields(value: unknown): void {
  walkSecrets(value, "$");
}

export interface AllocationLine {
  purpose: string;
  address: string;
  amountAtoms: number;
  amountZyn: string;
  remainingMiningBudgetAtoms: number;
}

export function explainAllocations(allocations: readonly { purpose: string; address: string; amountAtoms: number }[]): {
  lines: AllocationLine[];
  genesisSupplyAtoms: number;
  miningBudgetAtoms: number;
  withinSupplyCap: true;
} {
  const rejected = new Set(["founder", "premine", "team", "hidden", "admin", "emergency", "emergency-mint"]);
  let genesisSupplyAtoms = 0;
  const lines: AllocationLine[] = [];
  for (const allocation of allocations) {
    if (rejected.has(allocation.purpose)) {
      throw new Error("Founder, premine, and team allocations are rejected, including hidden, admin, and emergency mint");
    }
    if (!Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) throw new Error("Invalid allocation amount");
    genesisSupplyAtoms += allocation.amountAtoms;
    if (genesisSupplyAtoms > MAX_SUPPLY_ATOMS) throw new Error("GENESIS supply plus mining budget exceeds 50M ZYN");
    const remainingMiningBudgetAtoms = MAX_SUPPLY_ATOMS - genesisSupplyAtoms;
    lines.push({
      purpose: allocation.purpose,
      address: allocation.address,
      amountAtoms: allocation.amountAtoms,
      amountZyn: formatZyn(allocation.amountAtoms),
      remainingMiningBudgetAtoms
    });
  }
  return {
    lines,
    genesisSupplyAtoms,
    miningBudgetAtoms: MAX_SUPPLY_ATOMS - genesisSupplyAtoms,
    withinSupplyCap: true
  };
}

export function assertIndependentGenesisReproduction(left: string, right: string): void {
  if (left !== right) throw new Error("STOP: independent genesis builds are not byte-identical");
}

export function assertNoGenesisRegeneration(
  frozen: { chainId: string; genesisHash: string },
  next: { chainId: string; genesisHash: string }
): void {
  if (frozen.chainId === next.chainId && frozen.genesisHash !== next.genesisHash) {
    throw new Error("Refusing to regenerate genesis for a frozen chain ID");
  }
}

export function classifySoakRun(
  samples: readonly { observedAtMs: number }[],
  duration: keyof typeof SOAK_HORIZON_MS,
  progress: boolean
): "NOT RUN" | "PASS" | "FAIL" {
  if (samples.length < 2) return "NOT RUN";
  const span = samples[samples.length - 1]!.observedAtMs - samples[0]!.observedAtMs;
  if (!Number.isSafeInteger(span) || span < SOAK_HORIZON_MS[duration]) return "NOT RUN";
  return progress ? "PASS" : "FAIL";
}

export function measureClaimShares(acceptedByMiner: readonly number[]): {
  shares: number[];
  maxShare: number;
  minShare: number;
  fairnessProven: false;
} {
  const total = acceptedByMiner.reduce((sum, count) => sum + count, 0);
  const shares = acceptedByMiner.map((count) => total === 0 ? 0 : count / total);
  return {
    shares,
    maxShare: shares.reduce((max, share) => Math.max(max, share), 0),
    minShare: shares.reduce((min, share) => Math.min(min, share), shares[0] ?? 0),
    fairnessProven: false
  };
}

export function searchMiningWorkNonce(input: Omit<MiningWorkFields, "workNonce">, limit = 4_000_000): { workNonce: string; trials: number } {
  if (input.rewardAtoms !== miningRewardAtoms(0, 0) || input.rewardAtoms !== INITIAL_MINING_REWARD_ATOMS) {
    throw new Error("First mining claim rehearsal must use the 6.25 ZYN reward");
  }
  if (MINING_DIFFICULTY_BITS !== 20) throw new Error("Mining difficulty drifted");
  for (let trial = 0; trial < limit; trial += 1) {
    const workNonce = trial.toString(16).padStart(16, "0");
    const hash = miningWorkHash({ ...input, workNonce });
    if (meetsMiningDifficulty(hash, 20)) return { workNonce, trials: trial + 1 };
  }
  throw new Error("First mining claim rehearsal did not find 20-bit work inside the trial cap");
}

export function assertSingleMiningClaimPerBlock(claimCount: number): void {
  if (claimCount !== 1) throw new Error("A block accepts at most one mining claim");
}

export function parseOperatorInputPack(value: unknown): { status: typeof OPERATOR_STATUS_LABEL; officialGenesis: false } {
  assertNoSecretFields(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid operator input pack");
  const record = value as Record<string, unknown>;
  if (record.status !== OPERATOR_STATUS_LABEL) throw new Error("Operator input pack is not awaiting real operator input");
  if (record.networkName !== PUBLIC_TESTNET_CANDIDATE_NETWORK_NAME || record.chainId !== PUBLIC_TESTNET_CANDIDATE_CHAIN_ID) {
    throw new Error("Operator input pack chain identity drifted");
  }
  if (record.genesisTimestampMs !== null) throw new Error("Operator input pack must not invent a genesis timestamp");
  if (record.officialGenesis === true || record.governanceApproved === true || record.launchReady === true) {
    throw new Error("Operator input pack cannot mark genesis or launch ready");
  }
  return { status: OPERATOR_STATUS_LABEL, officialGenesis: false };
}

export function formatPublicTestnetPreflight(report: PublicTestnetPreflightReport): string {
  const identity = report.networkIdentity;
  return [
    "NETWORK",
    `  name: ${identity.networkName}`,
    `  chainId: ${identity.chainId}`,
    `  status: ${OPERATOR_STATUS_LABEL}`,
    `  machineStatus: ${identity.candidateStatus}`,
    "GENESIS",
    "  genesis: NOT BUILT",
    "  official: no",
    "BOOTSTRAP",
    `  bootstraps: ${identity.bootstraps}`,
    `  status: ${OPERATOR_STATUS_LABEL}`,
    "RPC",
    `  publicRpc: ${identity.publicRpc}`,
    `  archive: ${identity.archive}`,
    `  monitoring: ${identity.monitoring}`,
    "PROTOCOL",
    "  genesisProtocol: 1",
    "  protocolV5: quorum-delayed-upgrade",
    `  ${STOP_SHIP_DOUBLE_HASH_REVIEW}`,
    "MINING",
    "  mining: INACTIVE",
    "  publicMiningActivated: false",
    "SOAK",
    "  24h: NOT RUN",
    "  72h: NOT RUN",
    "  7d: NOT RUN",
    "AUTHORIZATION",
    "  authorization: BLOCKED",
    `  validators: ${identity.validators}`,
    `  regions: ${identity.regions}`,
    `  engineering: ${identity.engineeringReadiness}`,
    `  deployment: ${identity.deploymentReadiness}`,
    `  activation: ${identity.activationReadiness}`,
    "NETWORK IDENTITY",
    ""
  ].join("\n");
}

function formatZyn(amountAtoms: number): string {
  const whole = Math.floor(amountAtoms / ATOMS_PER_ZYN);
  const fraction = amountAtoms % ATOMS_PER_ZYN;
  if (fraction === 0) return String(whole);
  return `${whole}.${fraction.toString().padStart(8, "0").replace(/0+$/, "")}`;
}

function walkSecrets(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => walkSecrets(entry, `${path}[${index}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEYS.has(key.toLowerCase())) throw new Error(`Operator artifact refuses secret field ${path}.${key}`);
    walkSecrets(entry, `${path}.${key}`);
  }
}
