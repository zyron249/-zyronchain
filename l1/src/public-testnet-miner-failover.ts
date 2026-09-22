import { assertMiningNetworkIdentity } from "./miner-network.js";
import { assertPublicTestnetChainId } from "./public-testnet-governance.js";

export interface MinerRpcStatus {
  chainId: string;
  genesisHash: string;
  height: number;
  tipHash: string;
}

export interface MinerRpcProbe {
  url: string;
  reachable: boolean;
  status?: MinerRpcStatus;
}

export interface MinerRpcSelection {
  selectedUrl: string | null;
  selectedStatus: MinerRpcStatus | null;
  rejected: { url: string; reason: string }[];
  staleWorkInvalidated: boolean;
  backoffMs: number;
  spamRefused: boolean;
}

const WINDOW_MS = 10_000;
const MAX_ATTEMPTS_PER_WINDOW = 4;

export function minerRpcBackoffMs(attempt: number, nowMs: number): number {
  if (!Number.isSafeInteger(attempt) || attempt < 0 || !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new Error("Invalid miner RPC backoff input");
  }
  const capped = Math.min(attempt, 6);
  const base = 250 * (2 ** capped);
  const jitter = (nowMs + attempt * 17) % 100;
  return base + jitter;
}

export function selectMinerRpcEndpoint(input: {
  probes: readonly MinerRpcProbe[];
  expectedChainId: string;
  expectedGenesisHash: string;
  previousWork?: { height: number; tipHash: string } | null;
  attempt: number;
  nowMs: number;
  windowStartedAtMs: number;
  attemptsInWindow: number;
  privateMaterial?: unknown;
}): MinerRpcSelection {
  if (input.privateMaterial !== undefined) {
    throw new Error("Miner RPC failover refuses private key material");
  }
  assertPublicTestnetChainId(input.expectedChainId);
  if (!/^[0-9a-f]{64}$/.test(input.expectedGenesisHash)) throw new Error("Invalid expected genesis hash");
  const backoffMs = minerRpcBackoffMs(input.attempt, input.nowMs);
  const inWindow = input.nowMs - input.windowStartedAtMs < WINDOW_MS;
  if (inWindow && input.attemptsInWindow >= MAX_ATTEMPTS_PER_WINDOW) {
    return {
      selectedUrl: null,
      selectedStatus: null,
      rejected: input.probes.map((probe) => ({ url: probe.url, reason: "request-spam-refused" })),
      staleWorkInvalidated: true,
      backoffMs,
      spamRefused: true
    };
  }
  const rejected: { url: string; reason: string }[] = [];
  for (const probe of input.probes) {
    if (!probe.reachable || !probe.status) {
      rejected.push({ url: probe.url, reason: "unreachable" });
      continue;
    }
    try {
      assertMiningNetworkIdentity(probe.status, input.expectedChainId, input.expectedGenesisHash);
    } catch (error) {
      const message = (error as Error).message;
      rejected.push({
        url: probe.url,
        reason: message.includes("genesis hash") ? "genesis-hash-mismatch" : "chain-id-mismatch"
      });
      continue;
    }
    const staleWorkInvalidated = input.previousWork !== undefined && input.previousWork !== null &&
      (input.previousWork.tipHash !== probe.status.tipHash || input.previousWork.height !== probe.status.height);
    return {
      selectedUrl: probe.url,
      selectedStatus: probe.status,
      rejected,
      staleWorkInvalidated,
      backoffMs,
      spamRefused: false
    };
  }
  return {
    selectedUrl: null,
    selectedStatus: null,
    rejected,
    staleWorkInvalidated: true,
    backoffMs,
    spamRefused: false
  };
}
