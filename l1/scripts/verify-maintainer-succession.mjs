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
  assert.ok(text.includes(needle), `${label} is missing required text: ${needle}`);
}

const policyPath = option("--policy");
const outputPath = option("--out");
const commitSha = option("--commit-sha");
if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("--commit-sha must be a lowercase 40-hex Git commit SHA");

const policyBytes = await readFile(policyPath);
const policy = JSON.parse(policyBytes.toString("utf8"));
exactKeys(policy, [
  "policyVersion", "status", "publicTestnetAuthorized", "mainnetAuthorized",
  "minimumIndependentMaintainersBeforePublicTestnet", "uniqueFounderAuthorityForbidden",
  "requiredContinuityDomains", "requiredPublicArtifacts", "externalEvidenceRequired"
], "maintainer succession policy");
assert.equal(policy.policyVersion, 1);
assert.equal(policy.status, "prepared-requires-independent-custodians");
assert.equal(policy.publicTestnetAuthorized, false, "Succession policy must not authorize public testnet");
assert.equal(policy.mainnetAuthorized, false, "Succession policy must not authorize mainnet");
assert.ok(Number.isSafeInteger(policy.minimumIndependentMaintainersBeforePublicTestnet));
assert.ok(policy.minimumIndependentMaintainersBeforePublicTestnet >= 2, "Public-testnet succession must require at least two independent custodians");
assert.equal(policy.uniqueFounderAuthorityForbidden, true, "Unique founder authority must remain forbidden");

for (const [label, values] of [
  ["requiredContinuityDomains", policy.requiredContinuityDomains],
  ["requiredPublicArtifacts", policy.requiredPublicArtifacts],
  ["externalEvidenceRequired", policy.externalEvidenceRequired]
]) uniqueStrings(values, label);

const requiredDomains = [
  "repository-administration",
  "release-and-tagging",
  "security-response",
  "domain-and-checkpoint-publication",
  "operator-documentation"
];
for (const domain of requiredDomains) assert.ok(policy.requiredContinuityDomains.includes(domain), `Missing continuity domain: ${domain}`);

const requiredExternalEvidence = [
  "two-independent-maintainers-or-custodians",
  "protected-branch-review-policy-active",
  "release-credentials-not-single-founder-controlled",
  "security-reporting-channel-controlled-by-multiple-maintainers",
  "domain-checkpoint-channel-succession-rehearsed"
];
for (const gate of requiredExternalEvidence) assert.ok(policy.externalEvidenceRequired.includes(gate), `Missing external succession evidence: ${gate}`);

const requiredFiles = [
  "SECURITY.md",
  "docs/L1_MAINTAINER_SUCCESSION.md",
  "docs/L1_THREAT_MODEL.md",
  "docs/STANDALONE_L1_READINESS.md"
];
assert.deepEqual(new Set(policy.requiredPublicArtifacts), new Set(requiredFiles), "Succession public-artifact inventory is stale");

const files = [];
const contents = new Map();
for (const path of [...new Set([...requiredFiles, policyPath])].sort()) {
  const allowed = path === "SECURITY.md" || /^(docs\/)[A-Za-z0-9_./-]+$/.test(path);
  if (!allowed || path.includes("..")) throw new Error(`Unsafe succession path: ${path}`);
  const metadata = await stat(path);
  assert.ok(metadata.isFile(), `Succession path is not a regular file: ${path}`);
  const bytes = await readFile(path);
  files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  contents.set(path, bytes.toString("utf8"));
}

const security = contents.get("SECURITY.md");
requireText(security, "without publishing exploit details", "SECURITY.md");
requireText(security, "must not need founder-only private context", "SECURITY.md");
requireText(security, "No personal mailbox or founder-only credential may be the sole security channel", "SECURITY.md");
requireText(security, "does not authorize a public testnet or mainnet", "SECURITY.md");

const succession = contents.get("docs/L1_MAINTAINER_SUCCESSION.md");
requireText(succession, "at least two independent custodians", "maintainer succession document");
requireText(succession, "a unique founder admin/recovery/mint key", "maintainer succession document");
requireText(succession, "Actual identities, credentials, domains and custody assignments", "maintainer succession document");
requireText(succession, "Repository maintainership is not validator voting power", "maintainer succession document");

const threatModel = contents.get("docs/L1_THREAT_MODEL.md");
requireText(threatModel, "founders control a validator quorum or unique recovery/admin key", "threat model");
requireText(threatModel, "source, domains, release credentials or security contact have no succession", "threat model");
requireText(threatModel, "Founder exit must be a verified transfer of operational capability", "threat model");

const readiness = contents.get("docs/STANDALONE_L1_READINESS.md");
requireText(readiness, "Public testnet launch is currently blocked", "readiness");
requireText(readiness, "protected-branch/review release policy", "readiness");

const result = {
  status: "ok",
  successionPolicyVersion: policy.policyVersion,
  policyStatus: policy.status,
  repository: process.env.GITHUB_REPOSITORY ?? "local-checkout",
  commitSha,
  publicTestnetAuthorized: false,
  mainnetAuthorized: false,
  minimumIndependentMaintainersBeforePublicTestnet: policy.minimumIndependentMaintainersBeforePublicTestnet,
  uniqueFounderAuthorityForbidden: policy.uniqueFounderAuthorityForbidden,
  requiredContinuityDomains: [...policy.requiredContinuityDomains].sort(),
  externalEvidenceStillRequired: [...policy.externalEvidenceRequired].sort(),
  files
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
