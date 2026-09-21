import { assertExactKeys, assertPlainRecord } from "./transaction.js";

/** Stricter than the combined validator RPC defaults. A public role cannot raise these. */
export const PUBLIC_RPC_LIMITS = {
  requestsPerWindow: 60,
  windowMs: 60_000,
  maxRequestBytes: 65_536,
  requestTimeoutMs: 5_000,
  headersTimeoutMs: 5_000,
  maxConnections: 64,
  maxInflightRequests: 16
} as const;

export const PUBLIC_RPC_PLACEHOLDER = "PLACEHOLDER";

const LIMIT_KEYS = [
  "requestsPerWindow",
  "windowMs",
  "maxRequestBytes",
  "requestTimeoutMs",
  "headersTimeoutMs",
  "maxConnections",
  "maxInflightRequests"
] as const;

const FILE_KEYS = [
  "schemaVersion",
  "status",
  "networkClass",
  "live",
  "environmentIgnored",
  "publicRole",
  "validatorRole",
  "publicLimits"
] as const;

const PUBLIC_ROLE_KEYS = ["enabled", "bindHost", "portEnv", "originEnv", "origins"] as const;
const VALIDATOR_ROLE_KEYS = ["bindHost", "portEnv", "servesConsensusRoutes"] as const;

export type RpcRouteClass = "public" | "consensus" | "operator" | "unknown";

export interface PublicTestnetRpcConfig {
  schemaVersion: 1;
  status: "proposal-unfilled";
  networkClass: "public-testnet";
  live: false;
  environmentIgnored: true;
  publicRole: {
    enabled: false;
    bindHost: typeof PUBLIC_RPC_PLACEHOLDER;
    portEnv: "ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_PORT";
    originEnv: ["ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A", "ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_B"];
    origins: [typeof PUBLIC_RPC_PLACEHOLDER, typeof PUBLIC_RPC_PLACEHOLDER];
  };
  validatorRole: {
    bindHost: typeof PUBLIC_RPC_PLACEHOLDER;
    portEnv: "ZYRON_PUBLIC_TESTNET_VALIDATOR_RPC_PORT";
    servesConsensusRoutes: true;
  };
  publicLimits: { [Key in keyof typeof PUBLIC_RPC_LIMITS]: (typeof PUBLIC_RPC_LIMITS)[Key] };
}

export interface PublicTestnetRpcAdmission {
  bindTargets: [];
  reasons: string[];
}

export function classifyRpcRoute(method: string, pathname: string): RpcRouteClass {
  if (method === "GET" && (pathname === "/rpc-info" || pathname === "/status" || pathname === "/protocol" || pathname === "/healthz" || pathname === "/readyz")) {
    return "public";
  }
  if (method === "GET" && (pathname.startsWith("/balance/") || pathname.startsWith("/nonce/"))) return "public";
  if (method === "POST" && pathname === "/tx") return "public";
  if (method === "POST" && (pathname === "/proposal/attest" || pathname === "/round/skip" || pathname === "/round/lock" || pathname === "/block")) return "consensus";
  if (method === "GET" && (pathname === "/metrics" || pathname === "/peers" || pathname === "/peer-record" || pathname === "/blocks")) {
    return "operator";
  }
  return "unknown";
}

export function parsePublicTestnetRpc(value: unknown): PublicTestnetRpcConfig {
  assertPlainRecord(value, "public-testnet rpc");
  assertExactKeys(value, FILE_KEYS, "public-testnet rpc");
  if (value.schemaVersion !== 1) throw new Error("Invalid public-testnet rpc schema version");
  if (value.status !== "proposal-unfilled") throw new Error("Public-testnet rpc proposal must stay unfilled");
  if (value.networkClass !== "public-testnet") throw new Error("Invalid public-testnet rpc network class");
  if (value.live !== false) throw new Error("Public-testnet rpc cannot be marked live");
  if (value.environmentIgnored !== true) throw new Error("Public-testnet rpc must ignore process environment");
  return {
    schemaVersion: 1,
    status: "proposal-unfilled",
    networkClass: "public-testnet",
    live: false,
    environmentIgnored: true,
    publicRole: parsePublicRole(value.publicRole),
    validatorRole: parseValidatorRole(value.validatorRole),
    publicLimits: parseLimits(value.publicLimits)
  };
}

/** Placeholder origins are not bind targets. The public role stays disabled. */
export function admitPublicTestnetRpc(
  config: PublicTestnetRpcConfig,
  publicTestnetActivationAllowed: boolean
): PublicTestnetRpcAdmission {
  const reasons = ["public-rpc-unfilled", "public-rpc-not-bindable"];
  if (publicTestnetActivationAllowed !== true) reasons.push("public-testnet-activation-not-allowed");
  if (config.publicRole.enabled !== false || config.live !== false) reasons.push("public-rpc-enabled");
  return { bindTargets: [], reasons };
}

function parsePublicRole(value: unknown): PublicTestnetRpcConfig["publicRole"] {
  assertPlainRecord(value, "public rpc role");
  assertExactKeys(value, PUBLIC_ROLE_KEYS, "public rpc role");
  if (value.enabled !== false) throw new Error("Public RPC role must stay disabled");
  if (value.bindHost !== PUBLIC_RPC_PLACEHOLDER) throw new Error("Public RPC bind host must stay PLACEHOLDER");
  if (value.portEnv !== "ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_PORT") throw new Error("Invalid public RPC port variable");
  if (!Array.isArray(value.originEnv) || value.originEnv.length !== 2 ||
      value.originEnv[0] !== "ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A" ||
      value.originEnv[1] !== "ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_B") {
    throw new Error("Public RPC origin variables must be the two documented placeholders");
  }
  if (!Array.isArray(value.origins) || value.origins.length !== 2 ||
      value.origins[0] !== PUBLIC_RPC_PLACEHOLDER || value.origins[1] !== PUBLIC_RPC_PLACEHOLDER) {
    throw new Error("Public RPC origins must stay PLACEHOLDER");
  }
  return {
    enabled: false,
    bindHost: PUBLIC_RPC_PLACEHOLDER,
    portEnv: "ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_PORT",
    originEnv: ["ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A", "ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_B"],
    origins: [PUBLIC_RPC_PLACEHOLDER, PUBLIC_RPC_PLACEHOLDER]
  };
}

function parseValidatorRole(value: unknown): PublicTestnetRpcConfig["validatorRole"] {
  assertPlainRecord(value, "validator rpc role");
  assertExactKeys(value, VALIDATOR_ROLE_KEYS, "validator rpc role");
  if (value.bindHost !== PUBLIC_RPC_PLACEHOLDER) throw new Error("Validator RPC bind host must stay PLACEHOLDER");
  if (value.portEnv !== "ZYRON_PUBLIC_TESTNET_VALIDATOR_RPC_PORT") throw new Error("Invalid validator RPC port variable");
  if (value.servesConsensusRoutes !== true) throw new Error("Validator RPC role must keep consensus routes");
  return {
    bindHost: PUBLIC_RPC_PLACEHOLDER,
    portEnv: "ZYRON_PUBLIC_TESTNET_VALIDATOR_RPC_PORT",
    servesConsensusRoutes: true
  };
}

function parseLimits(value: unknown): PublicTestnetRpcConfig["publicLimits"] {
  assertPlainRecord(value, "public rpc limits");
  assertExactKeys(value, LIMIT_KEYS, "public rpc limits");
  for (const key of LIMIT_KEYS) {
    if (value[key] !== PUBLIC_RPC_LIMITS[key]) {
      throw new Error(`Public RPC ${key} must match the pinned public-role ceiling`);
    }
  }
  return { ...PUBLIC_RPC_LIMITS };
}
