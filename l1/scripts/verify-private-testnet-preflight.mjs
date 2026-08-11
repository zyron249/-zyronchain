#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has unexpected fields`);
}

function uniqueStrings(values, label) {
  assert.ok(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  for (const value of values) assert.equal(typeof value, "string", `${label} entries must be strings`);
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

function requireText(text, needle, label) {
  assert.ok(text.includes(needle), `${label} is missing required safety text: ${needle}`);
}

const configPath = option("--config");
const outputPath = option("--out");
const commitSha = option("--commit-sha");
if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("--commit-sha must be a lowercase 40-hex Git commit SHA");

const configBytes = await readFile(configPath);
const config = JSON.parse(configBytes.toString("utf8"));
exactKeys(config, [
  "preflightVersion", "status", "canonicalImplementation", "publicTestnetAuthorized", "mainnetAuthorized",
  "requiredInternalControls", "remainingExternalGates", "mainnetOnlyUnresolvedDecisions", "architectureDecisionsNotImplicitlyChanged"
], "private-testnet preflight config");
assert.equal(config.preflightVersion, 1);
assert.equal(config.status, "internal-private-adversarial-preflight");
assert.equal(config.canonicalImplementation, "l1/");
assert.equal(config.publicTestnetAuthorized, false, "Preflight must never authorize a public testnet");
assert.equal(config.mainnetAuthorized, false, "Preflight must never authorize mainnet");

for (const [label, values] of [
  ["requiredInternalControls", config.requiredInternalControls],
  ["remainingExternalGates", config.remainingExternalGates],
  ["mainnetOnlyUnresolvedDecisions", config.mainnetOnlyUnresolvedDecisions],
  ["architectureDecisionsNotImplicitlyChanged", config.architectureDecisionsNotImplicitlyChanged]
]) uniqueStrings(values, label);

const requiredControls = new Set([
  "canonical-l1-and-legacy-separation",
  "public-launch-explicitly-blocked",
  "node-22-and-24-ci",
  "independent-light-client-verification",
  "protocol-v5-permissionless-mining-tests",
  "mining-mempool-resource-bound",
  "composite-adversarial-soak",
  "multiprocess-native-p2p-crash-recovery",
  "mixed-version-upgrade-rollback",
  "disaster-recovery-restore-catchup-restart",
  "validator-key-rotation",
  "machine-readable-ci-evidence",
  "external-audit-handoff-prepared",
  "operations-runbook-and-threat-model",
  "founder-independent-security-and-succession-policy"
]);
assert.deepEqual(new Set(config.requiredInternalControls), requiredControls, "Internal control inventory is stale");

const mandatoryExternalGates = [
  "independent-operators-deploy-from-release-artifacts-without-founder-assistance",
  "bootstrap-archive-monitoring-across-independent-failure-domains",
  "target-hardware-state-v2-scale-and-recovery-measurements",
  "independent-consensus-cryptography-network-audit-and-retest",
  "independent-mining-contention-target-calibration-and-retest",
  "sustained-independent-operator-internet-adversarial-soak",
  "production-hsm-or-audited-signer-custody-and-cross-host-rotation",
  "protected-branch-independent-review-repository-policy",
  "independent-maintainer-and-security-custody-succession-evidence"
];
for (const gate of mandatoryExternalGates) {
  assert.ok(config.remainingExternalGates.includes(gate), `External gate was silently removed: ${gate}`);
}

for (const decision of [
  "immutable-mainnet-chain-id",
  "immutable-mainnet-genesis-allocation",
  "mining-difficulty-retarget-and-final-mainnet-calibration",
  "validator-reward-inflation-and-fee-policy",
  "activity-oracle-production-governance",
  "validator-admission-removal-governance"
]) assert.ok(config.mainnetOnlyUnresolvedDecisions.includes(decision), `Irreversible decision was silently finalized: ${decision}`);

assert.ok(config.architectureDecisionsNotImplicitlyChanged.includes("current-permissioned-poa-bft-consensus"));
assert.ok(config.architectureDecisionsNotImplicitlyChanged.includes("proof-of-work-is-issuance-only-not-chain-selection"));

const filesToRead = [
  "README.md",
  "SECURITY.md",
  "l1/package.json",
  ".github/workflows/l1.yml",
  ".github/workflows/l1-key-rotation.yml",
  ".github/workflows/l1-audit-pack.yml",
  ".github/workflows/l1-private-testnet-preflight.yml",
  ".github/workflows/l1-succession-policy.yml",
  "docs/STANDALONE_L1_READINESS.md",
  "docs/L1_THREAT_MODEL.md",
  "docs/MINING.md",
  "docs/L1_OPERATIONS_RUNBOOK.md",
  "docs/L1_CI_EVIDENCE.md",
  "docs/L1_KEY_ROTATION_REHEARSAL.md",
  "docs/L1_EXTERNAL_AUDIT_PACKAGE.md",
  "docs/L1_PRIVATE_TESTNET_PREFLIGHT.md",
  "docs/L1_MAINTAINER_SUCCESSION.md",
  "docs/l1-audit-scope.json",
  "docs/l1-maintainer-succession.json",
  configPath,
  "l1/scripts/verify-maintainer-succession.mjs",
  "l1/scripts/verify-private-testnet-preflight.mjs"
];

const contents = new Map();
const files = [];
for (const path of [...new Set(filesToRead)].sort()) {
  const allowed = path === "README.md" || path === "SECURITY.md" || /^(l1\/|docs\/|\.github\/workflows\/)[A-Za-z0-9_./-]+$/.test(path);
  if (!allowed || path.includes("..")) throw new Error(`Unsafe preflight path: ${path}`);
  const metadata = await stat(path);
  assert.ok(metadata.isFile(), `Required preflight path is not a regular file: ${path}`);
  const bytes = await readFile(path);
  contents.set(path, bytes.toString("utf8"));
  files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}

const rootReadme = contents.get("README.md");
requireText(rootReadme, "The **canonical consensus implementation** is the standalone TypeScript L1", "README");
requireText(rootReadme, "No ZyronChain public testnet or value-bearing mainnet is authorized by this repository", "README");
requireText(rootReadme, "private/adversarial-development network", "README");
requireText(rootReadme, "legacy compatibility testnet", "README");
requireText(rootReadme, "Security disclosure", "README");
requireText(rootReadme, "Maintainer and security succession", "README");

const securityPolicy = contents.get("SECURITY.md");
requireText(securityPolicy, "without publishing exploit details", "SECURITY.md");
requireText(securityPolicy, "must not need founder-only private context", "SECURITY.md");
requireText(securityPolicy, "No personal mailbox or founder-only credential may be the sole security channel", "SECURITY.md");

const successionPolicy = JSON.parse(contents.get("docs/l1-maintainer-succession.json"));
assert.equal(successionPolicy.status, "prepared-requires-independent-custodians");
assert.equal(successionPolicy.publicTestnetAuthorized, false);
assert.equal(successionPolicy.mainnetAuthorized, false);
assert.ok(Number.isSafeInteger(successionPolicy.minimumIndependentMaintainersBeforePublicTestnet));
assert.ok(successionPolicy.minimumIndependentMaintainersBeforePublicTestnet >= 2);
assert.equal(successionPolicy.uniqueFounderAuthorityForbidden, true);
for (const gate of [
  "two-independent-maintainers-or-custodians",
  "protected-branch-review-policy-active",
  "release-credentials-not-single-founder-controlled",
  "security-reporting-channel-controlled-by-multiple-maintainers",
  "domain-checkpoint-channel-succession-rehearsed"
]) assert.ok(successionPolicy.externalEvidenceRequired?.includes(gate), `Succession external gate missing: ${gate}`);

const successionDoc = contents.get("docs/L1_MAINTAINER_SUCCESSION.md");
requireText(successionDoc, "at least two independent custodians", "maintainer succession documentation");
requireText(successionDoc, "Repository maintainership is not validator voting power", "maintainer succession documentation");
requireText(successionDoc, "Actual identities, credentials, domains and custody assignments", "maintainer succession documentation");

const readiness = contents.get("docs/STANDALONE_L1_READINESS.md");
requireText(readiness, "**Public testnet launch is currently blocked**", "readiness");
requireText(readiness, "standalone multi-validator devnet/testnet L1", "readiness");
requireText(readiness, "Independent cryptography/consensus/network review", "readiness");
requireText(readiness, "Mining contention/calibration evidence", "readiness");

const threatModel = contents.get("docs/L1_THREAT_MODEL.md");
requireText(threatModel, "pre-public-testnet security specification", "threat model");
requireText(threatModel, "A public testnet remains blocked until", "threat model");
requireText(threatModel, "independent operators can deploy from release artifacts without founder assistance", "threat model");
requireText(threatModel, "State-v2 scale and recovery limits are measured on target hardware", "threat model");
requireText(threatModel, "source, domains, release credentials or security contact have no succession", "threat model");
requireText(threatModel, "Permissionless issuance introduces a new competition surface", "threat model");

const miningDoc = contents.get("docs/MINING.md");
requireText(miningDoc, "Permissionless ZYN issuance is implemented", "mining documentation");
requireText(miningDoc, "protocol version 5", "mining documentation");
requireText(miningDoc, "does **not** replace ZyronChain validator finality", "mining documentation");

const packageJson = JSON.parse(contents.get("l1/package.json"));
assert.equal(packageJson.name, "@zyronchain/l1");
assert.equal(packageJson.engines?.node, ">=22", "Node engine policy changed without preflight review");
assert.ok(packageJson.files?.includes("scripts/mine.mjs"), "Packaged L1 release must include the standalone miner");
assert.ok(packageJson.files?.includes("MINING.md"), "Packaged L1 release must include the mining operator guide");

const l1Workflow = contents.get(".github/workflows/l1.yml");
requireText(l1Workflow, "node-version: [22, 24]", "Standalone L1 CI");
for (const job of [
  "mixed-version-rehearsal:",
  "disaster-recovery-rehearsal:",
  "composite-adversarial-soak:",
  "multiprocess-native-recovery:",
  "independent-light-client:"
]) requireText(l1Workflow, job, "Standalone L1 CI");

requireText(contents.get(".github/workflows/l1-key-rotation.yml"), "validator-key-rotation-rehearsal:", "key-rotation CI");
requireText(contents.get(".github/workflows/l1-audit-pack.yml"), "external-audit-pack:", "audit-pack CI");
requireText(contents.get(".github/workflows/l1-private-testnet-preflight.yml"), "private-testnet-preflight:", "private-testnet preflight CI");
requireText(contents.get(".github/workflows/l1-succession-policy.yml"), "maintainer-succession-policy:", "succession-policy CI");

const evidenceDoc = contents.get("docs/L1_CI_EVIDENCE.md");
for (const scenario of [
  "mixed-version-upgrade-rollback",
  "disaster-recovery",
  "composite-adversarial-soak",
  "multiprocess-native-recovery",
  "validator-key-rotation"
]) requireText(evidenceDoc, scenario, "CI evidence documentation");

requireText(contents.get("docs/L1_KEY_ROTATION_REHEARSAL.md"), "retired key", "key-rotation rehearsal documentation");
requireText(contents.get("docs/L1_EXTERNAL_AUDIT_PACKAGE.md"), "audit preparation only", "external audit documentation");
requireText(contents.get("docs/L1_PRIVATE_TESTNET_PREFLIGHT.md"), "internal engineering preflight only", "private-testnet preflight documentation");
const operationsRunbook = contents.get("docs/L1_OPERATIONS_RUNBOOK.md");
requireText(operationsRunbook, "## 4. Backup and checkpoint procedure", "operations runbook");
requireText(operationsRunbook, "## 5. Restore drill", "operations runbook");
requireText(operationsRunbook, "## 8. Disaster-recovery evidence checklist", "operations runbook");

const auditScope = JSON.parse(contents.get("docs/l1-audit-scope.json"));
assert.equal(auditScope.status, "pre-public-testnet-external-audit-preparation");
assert.deepEqual(auditScope.supportedProtocolVersions, [1, 2, 3, 5], "Audit scope protocol matrix is stale");
for (const gate of [
  "independent-consensus-cryptography-network-audit",
  "independent-mining-contention-target-calibration-review",
  "independent-operator-public-network-soak",
  "production-hsm-or-audited-signer-custody"
]) assert.ok(auditScope.externalGates?.includes(gate), `Audit scope external gate missing: ${gate}`);

const result = {
  status: "ok",
  preflightVersion: 1,
  internalPreflightPassed: true,
  publicTestnetAuthorized: false,
  mainnetAuthorized: false,
  repository: process.env.GITHUB_REPOSITORY ?? "local-checkout",
  commitSha,
  canonicalImplementation: config.canonicalImplementation,
  validatedInternalControls: [...config.requiredInternalControls].sort(),
  remainingExternalGates: [...config.remainingExternalGates].sort(),
  mainnetOnlyUnresolvedDecisions: [...config.mainnetOnlyUnresolvedDecisions].sort(),
  architectureDecisionsNotImplicitlyChanged: [...config.architectureDecisionsNotImplicitlyChanged].sort(),
  files
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
