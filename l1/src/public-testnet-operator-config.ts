export const OPERATOR_AWAITING = "AWAITING REAL OPERATOR INPUT";

export interface RoleMatrixEntry {
  roleName: string;
  failureDomain: string;
  requiresPublicIp: boolean;
  requiresPrivateNetwork: boolean;
  requiresPersistentDisk: boolean;
  requiresSecrets: boolean;
  mayHoldValidatorKey: boolean;
  mayHoldBootstrapKey: boolean;
  exposesPublicRpc: boolean;
  exposesP2p: boolean;
  exposesMetrics: boolean;
  backupRequired: boolean;
  minCpuCores: number;
  minRamGb: number;
  minDiskGb: number;
}

const ROLE_KEYS = [
  "roleName", "failureDomain", "requiresPublicIp", "requiresPrivateNetwork", "requiresPersistentDisk",
  "requiresSecrets", "mayHoldValidatorKey", "mayHoldBootstrapKey", "exposesPublicRpc", "exposesP2p",
  "exposesMetrics", "backupRequired", "minCpuCores", "minRamGb", "minDiskGb"
] as const;

export function parseRoleMatrix(value: unknown): { roles: RoleMatrixEntry[] } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid role matrix");
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.roles) || record.roles.length < 10) throw new Error("Role matrix needs the ten logical roles");
  const roles = record.roles.map((entry) => parseRole(entry));
  const names = new Set(roles.map((role) => role.roleName));
  for (const name of ["validator-a", "validator-b", "validator-c", "bootstrap-a", "bootstrap-b", "bootstrap-c", "rpc-a", "rpc-b", "archive-a", "monitoring-a"]) {
    if (!names.has(name)) throw new Error(`Role matrix missing ${name}`);
  }
  for (const role of roles) {
    if (role.roleName.startsWith("validator-") && role.mayHoldValidatorKey !== true) {
      throw new Error("Validators must be allowed to hold a validator key");
    }
    if ((role.roleName.startsWith("rpc-") || role.roleName === "archive-a" || role.roleName === "monitoring-a") && role.mayHoldValidatorKey) {
      throw new Error("RPC, archive, and monitoring must not hold a validator key");
    }
    if (role.exposesMetrics && role.roleName !== "monitoring-a") throw new Error("Metrics stay on the monitoring role");
    if (role.exposesPublicRpc && !role.roleName.startsWith("rpc-")) throw new Error("Public RPC exposure is limited to rpc roles");
  }
  return { roles };
}

export function parseHostOperatorFile(value: unknown): { status: typeof OPERATOR_AWAITING; filledHosts: number } {
  assertNoOperatorSecrets(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid host operator file");
  const record = value as Record<string, unknown>;
  if (record.status !== OPERATOR_AWAITING) throw new Error("Host operator file must await real operator input");
  if (!Array.isArray(record.hosts)) throw new Error("Host operator file needs a hosts array");
  let filledHosts = 0;
  for (const host of record.hosts) {
    if (host === null || typeof host !== "object" || Array.isArray(host)) throw new Error("Invalid host entry");
    const entry = host as Record<string, unknown>;
    if (typeof entry.roleName !== "string") throw new Error("Host entry needs a role name");
    if (entry.publicAddress !== null || entry.privateAddress !== null || entry.provider !== null) filledHosts += 1;
  }
  return { status: OPERATOR_AWAITING, filledHosts };
}

export function parseDomainRegistration(value: unknown): { status: typeof OPERATOR_AWAITING; domains: number } {
  assertNoOperatorSecrets(value);
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid domain registration");
  const record = value as Record<string, unknown>;
  if (record.status !== OPERATOR_AWAITING) throw new Error("Domain registration must await real operator input");
  if (!Array.isArray(record.names) || record.names.length !== 0) throw new Error("Domain registration example must not invent names");
  for (const name of record.names) {
    if (typeof name !== "string") throw new Error("Invalid domain");
    validateOperatorDomainName(name);
  }
  return { status: OPERATOR_AWAITING, domains: record.names.length };
}

export function validateOperatorDomainName(name: string): void {
  const lower = name.toLowerCase();
  if (lower.includes("example.com") || lower.includes("localhost") || lower.includes("placeholder") || lower.includes("changeme")) {
    throw new Error("Domain is not a real operator name");
  }
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(lower)) {
    throw new Error("Domain is not a DNS name");
  }
}

export function assertNoOperatorSecrets(value: unknown): void {
  const forbidden = new Set(["privatekey", "password", "mnemonic", "secret", "credential", "apikey", "token"]);
  walk(value, forbidden);
}

function parseRole(value: unknown): RoleMatrixEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid role");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expected = [...ROLE_KEYS].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) throw new Error("Invalid role fields");
  for (const key of ["requiresPublicIp", "requiresPrivateNetwork", "requiresPersistentDisk", "requiresSecrets", "mayHoldValidatorKey", "mayHoldBootstrapKey", "exposesPublicRpc", "exposesP2p", "exposesMetrics", "backupRequired"] as const) {
    if (typeof record[key] !== "boolean") throw new Error(`Invalid ${key}`);
  }
  for (const key of ["minCpuCores", "minRamGb", "minDiskGb"] as const) {
    if (!Number.isSafeInteger(record[key]) || Number(record[key]) < 1) throw new Error(`Invalid ${key}`);
  }
  if (typeof record.roleName !== "string" || typeof record.failureDomain !== "string") throw new Error("Invalid role name");
  return record as unknown as RoleMatrixEntry;
}

function walk(value: unknown, forbidden: Set<string>): void {
  if (Array.isArray(value)) {
    value.forEach((entry) => walk(entry, forbidden));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase())) throw new Error(`Operator file refuses ${key}`);
    walk(entry, forbidden);
  }
}
