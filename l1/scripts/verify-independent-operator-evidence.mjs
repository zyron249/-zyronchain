#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function exactKeys(value, expected, label) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${label} has unexpected fields`);
}

function uniqueStrings(values, label, minimum) {
  assert.ok(Array.isArray(values) && values.length >= minimum, `${label} requires at least ${minimum} entries`);
  for (const value of values) assert.equal(typeof value, "string", `${label} entries must be strings`);
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

function hex(value, bytes, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `${label} must be lowercase hex`);
}

const policyPath = option("--policy");
const evidencePath = option("--evidence");
const outputPath = option("--out");
const testVectorMode = process.argv.includes("--test-vector");

const policy = JSON.parse(await readFile(policyPath, "utf8"));
exactKeys(policy, [
  "challengeVersion", "status", "publicTestnetAuthorized", "mainnetAuthorized",
  "minimumBootstrapPeers", "minimumFailureDomains", "releaseSourceRequired",
  "sourceCheckoutForbiddenForChallenge", "founderPrivateAssistanceForbidden",
  "operatorKeysMustBeGeneratedLocally", "privateKeyDisclosureForbidden", "externalReviewRequired"
], "operator challenge policy");
assert.equal(policy.challengeVersion, 1);
assert.equal(policy.status, "prepared-external-operator-evidence-required");
assert.equal(policy.publicTestnetAuthorized, false);
assert.equal(policy.mainnetAuthorized, false);
assert.equal(policy.releaseSourceRequired, "published-release-artifact");
assert.equal(policy.sourceCheckoutForbiddenForChallenge, true);
assert.equal(policy.founderPrivateAssistanceForbidden, true);
assert.equal(policy.operatorKeysMustBeGeneratedLocally, true);
assert.equal(policy.privateKeyDisclosureForbidden, true);
assert.equal(policy.externalReviewRequired, true);
assert.ok(Number.isSafeInteger(policy.minimumBootstrapPeers) && policy.minimumBootstrapPeers >= 2);
assert.ok(Number.isSafeInteger(policy.minimumFailureDomains) && policy.minimumFailureDomains >= 2);

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
exactKeys(evidence, [
  "evidenceVersion", "evidenceMode", "operatorPseudonymHash", "testedCommitSha",
  "releaseArtifactSha256", "releaseChecksumsVerified", "sbomVerified", "provenanceVerified",
  "sourceCheckoutUsed", "founderPrivateAssistanceUsed", "keysGeneratedLocally", "privateKeysDisclosed",
  "chainId", "genesisHash", "checkpointTipHash", "checkpointSnapshotSha256",
  "bootstrapPeerIds", "failureDomains", "synchronizedHeight", "synchronizedTipHash",
  "restartRecovered", "restoreRehearsed", "startedAtUtc", "completedAtUtc", "notes"
], "independent operator evidence");

assert.equal(evidence.evidenceVersion, 1);
const expectedMode = testVectorMode ? "synthetic-test-vector" : "independent-operator-executed";
assert.equal(evidence.evidenceMode, expectedMode, `Evidence mode must be ${expectedMode}`);
hex(evidence.operatorPseudonymHash, 32, "operatorPseudonymHash");
hex(evidence.testedCommitSha, 20, "testedCommitSha");
hex(evidence.releaseArtifactSha256, 32, "releaseArtifactSha256");
hex(evidence.genesisHash, 32, "genesisHash");
hex(evidence.checkpointTipHash, 32, "checkpointTipHash");
hex(evidence.checkpointSnapshotSha256, 32, "checkpointSnapshotSha256");
hex(evidence.synchronizedTipHash, 32, "synchronizedTipHash");
assert.match(evidence.chainId, /^[a-z0-9-]{3,64}$/, "Invalid chainId");

for (const [field, expected] of [
  ["releaseChecksumsVerified", true],
  ["sbomVerified", true],
  ["provenanceVerified", true],
  ["sourceCheckoutUsed", false],
  ["founderPrivateAssistanceUsed", false],
  ["keysGeneratedLocally", true],
  ["privateKeysDisclosed", false],
  ["restartRecovered", true],
  ["restoreRehearsed", true]
]) assert.equal(evidence[field], expected, `${field} violates challenge policy`);

uniqueStrings(evidence.bootstrapPeerIds, "bootstrapPeerIds", policy.minimumBootstrapPeers);
uniqueStrings(evidence.failureDomains, "failureDomains", policy.minimumFailureDomains);
for (const peerId of evidence.bootstrapPeerIds) assert.match(peerId, /^[A-Za-z0-9]{16,128}$/, "Invalid bootstrap PeerId token");
for (const domain of evidence.failureDomains) assert.match(domain, /^[A-Za-z0-9._:-]{2,128}$/, "Invalid failure-domain label");
assert.ok(Number.isSafeInteger(evidence.synchronizedHeight) && evidence.synchronizedHeight >= 1, "Invalid synchronizedHeight");

const started = Date.parse(evidence.startedAtUtc);
const completed = Date.parse(evidence.completedAtUtc);
assert.ok(Number.isFinite(started) && Number.isFinite(completed) && completed > started, "Invalid evidence time range");
assert.equal(typeof evidence.notes, "string");
assert.ok(evidence.notes.length <= 2_000, "Evidence notes are too long");

const result = {
  status: "ok",
  evidenceVersion: evidence.evidenceVersion,
  evidenceMode: evidence.evidenceMode,
  operatorPseudonymHash: evidence.operatorPseudonymHash,
  testedCommitSha: evidence.testedCommitSha,
  chainId: evidence.chainId,
  genesisHash: evidence.genesisHash,
  synchronizedHeight: evidence.synchronizedHeight,
  synchronizedTipHash: evidence.synchronizedTipHash,
  bootstrapPeerCount: evidence.bootstrapPeerIds.length,
  declaredFailureDomainCount: evidence.failureDomains.length,
  restartRecovered: evidence.restartRecovered,
  restoreRehearsed: evidence.restoreRehearsed,
  founderPrivateAssistanceUsed: evidence.founderPrivateAssistanceUsed,
  independenceProven: false,
  externalReviewRequired: true,
  publicTestnetAuthorized: false,
  mainnetAuthorized: false
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
