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

function uniqueStrings(values, label) {
  assert.ok(Array.isArray(values) && values.length > 0, `${label} must be a non-empty array`);
  for (const value of values) assert.equal(typeof value, "string", `${label} entries must be strings`);
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

function exactKeys(value, keys, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert.deepEqual(actual, expected, `${label} has unexpected fields`);
}

const scopePath = option("--scope");
const outputPath = option("--out");
const commitSha = option("--commit-sha");
if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("--commit-sha must be a lowercase 40-hex Git commit SHA");

const scopeBytes = await readFile(scopePath);
const scope = JSON.parse(scopeBytes.toString("utf8"));
exactKeys(scope, [
  "scopeVersion", "status", "canonicalImplementation", "supportedProtocolVersions", "reviewAreas",
  "criticalModules", "securitySpecifications", "independentVerification", "securityInvariants",
  "requiredCommands", "evidenceScenarios", "externalGates", "deliberatelyExcludedDecisions"
], "audit scope");
assert.equal(scope.scopeVersion, 1, "Unsupported audit scope version");
assert.equal(scope.status, "pre-public-testnet-external-audit-preparation");
assert.equal(scope.canonicalImplementation, "l1/");
assert.deepEqual(scope.supportedProtocolVersions, [1, 2, 3], "Audit scope protocol matrix is stale");

for (const [label, values] of [
  ["reviewAreas", scope.reviewAreas],
  ["criticalModules", scope.criticalModules],
  ["securitySpecifications", scope.securitySpecifications],
  ["independentVerification", scope.independentVerification],
  ["requiredCommands", scope.requiredCommands],
  ["evidenceScenarios", scope.evidenceScenarios],
  ["externalGates", scope.externalGates],
  ["deliberatelyExcludedDecisions", scope.deliberatelyExcludedDecisions]
]) uniqueStrings(values, label);

assert.ok(Array.isArray(scope.securityInvariants) && scope.securityInvariants.length >= 10, "Security invariant inventory is incomplete");
const invariantIds = new Set();
const referencedModules = new Set();
for (const invariant of scope.securityInvariants) {
  exactKeys(invariant, ["id", "statement", "primaryModules"], "security invariant");
  assert.match(invariant.id, /^[A-Z]+-[0-9]{3}$/);
  assert.ok(!invariantIds.has(invariant.id), `Duplicate security invariant ${invariant.id}`);
  invariantIds.add(invariant.id);
  assert.equal(typeof invariant.statement, "string");
  assert.ok(invariant.statement.length >= 40, `Security invariant ${invariant.id} is underspecified`);
  uniqueStrings(invariant.primaryModules, `${invariant.id}.primaryModules`);
  for (const path of invariant.primaryModules) referencedModules.add(path);
}

const criticalSet = new Set(scope.criticalModules);
for (const path of referencedModules) {
  assert.ok(criticalSet.has(path), `Invariant references non-critical module not in scope: ${path}`);
}

const requiredEvidence = new Set([
  "mixed-version-upgrade-rollback",
  "disaster-recovery",
  "composite-adversarial-soak",
  "multiprocess-native-recovery",
  "validator-key-rotation",
  "release-artifact-operator",
  "independent-operator-challenge",
  "state-v2-scale-100k",
  "render-hosting-profile",
  "hosted-duration-soak-evidence",
  "launch-authorization"
]);
assert.deepEqual(new Set(scope.evidenceScenarios), requiredEvidence, "High-risk evidence scenario inventory is stale");

const requiredExternalGates = [
  "independent-consensus-cryptography-network-audit",
  "independent-operator-public-network-soak",
  "production-hsm-or-audited-signer-custody",
  "immutable-mainnet-genesis-economics-and-oracle-governance",
  "independent-maintainer-security-release-custody-succession",
  "always-on-duration-soak-evidence"
];
for (const gate of requiredExternalGates) assert.ok(scope.externalGates.includes(gate), `Missing external gate: ${gate}`);

const requiredControlFiles = [
  "l1/scripts/archive-ci-evidence.mjs",
  "l1/scripts/build-external-audit-pack.mjs",
  "l1/scripts/verify-maintainer-succession.mjs",
  "l1/scripts/verify-private-testnet-preflight.mjs",
  "l1/scripts/artifact-operator-rehearsal.mjs",
  "l1/scripts/verify-independent-operator-evidence.mjs",
  "l1/scripts/normalize-state-v2-scale-evidence.mjs",
  "l1/scripts/verify-render-hosting-profile.mjs",
  "l1/scripts/verify-hosted-duration-soak-evidence.mjs",
  "l1/scripts/verify-launch-authorization.mjs",
  "l1/test-vectors/hosted-duration-soak-valid.json",
  "l1/test-vectors/hosted-duration-soak-invalid.json",
  ".github/workflows/l1-audit-pack.yml",
  ".github/workflows/l1-succession-policy.yml",
  ".github/workflows/l1-private-testnet-preflight.yml",
  ".github/workflows/l1-artifact-operator.yml",
  ".github/workflows/l1-independent-operator-challenge.yml",
  ".github/workflows/l1-state-v2-scale.yml",
  ".github/workflows/l1-render-hosting-profile.yml",
  ".github/workflows/l1-hosted-duration-soak-evidence.yml",
  ".github/workflows/l1-launch-authorization.yml"
];

const paths = [...new Set([
  ...scope.criticalModules,
  ...scope.securitySpecifications,
  ...scope.independentVerification,
  "l1/package.json",
  "l1/package-lock.json",
  ...requiredControlFiles
])].sort();

const files = [];
for (const path of paths) {
  const allowed = path === "SECURITY.md" || /^(l1\/|docs\/|\.github\/workflows\/)[A-Za-z0-9_./-]+$/.test(path);
  if (!allowed || path.includes("..")) throw new Error(`Unsafe audit path: ${path}`);
  const metadata = await stat(path);
  assert.ok(metadata.isFile(), `Audit path is not a regular file: ${path}`);
  const bytes = await readFile(path);
  files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
}

const packageJson = JSON.parse(await readFile("l1/package.json", "utf8"));
assert.equal(packageJson.name, "@zyronchain/l1");
assert.ok(packageJson.engines?.node, "L1 package must declare a Node.js engine policy");

const pack = {
  auditPackVersion: 1,
  status: "prepared-not-independently-audited",
  repository: process.env.GITHUB_REPOSITORY ?? "local-checkout",
  commitSha,
  scope: {
    path: scopePath,
    sha256: sha256(scopeBytes),
    scopeVersion: scope.scopeVersion,
    canonicalImplementation: scope.canonicalImplementation,
    supportedProtocolVersions: scope.supportedProtocolVersions
  },
  package: {
    name: packageJson.name,
    version: packageJson.version,
    nodeEngine: packageJson.engines.node
  },
  counts: {
    reviewAreas: scope.reviewAreas.length,
    securityInvariants: scope.securityInvariants.length,
    criticalModules: scope.criticalModules.length,
    evidenceScenarios: scope.evidenceScenarios.length,
    externalGates: scope.externalGates.length
  },
  files,
  securityInvariantIds: [...invariantIds].sort(),
  evidenceScenarios: [...scope.evidenceScenarios].sort(),
  externalGates: [...scope.externalGates].sort(),
  deliberatelyExcludedDecisions: [...scope.deliberatelyExcludedDecisions].sort(),
  generatedBy: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  }
};

await writeFile(outputPath, `${JSON.stringify(pack, null, 2)}\n`, { flag: "wx", mode: 0o644 });
