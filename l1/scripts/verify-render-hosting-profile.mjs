#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function uniqueStrings(values, label) {
  assert.ok(Array.isArray(values) && values.length > 0, `${label} must be non-empty`);
  for (const value of values) assert.equal(typeof value, "string", `${label} entries must be strings`);
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

const policyPath = option("--policy");
const docsPath = option("--docs");
const outputPath = option("--out");
const commitSha = option("--commit-sha");
if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error("--commit-sha must be a lowercase 40-hex Git commit SHA");

const policyBytes = await readFile(policyPath);
const docsBytes = await readFile(docsPath);
const policy = JSON.parse(policyBytes.toString("utf8"));
assert.equal(policy.policyVersion, 1);
assert.equal(policy.status, "free-profile-smoke-only");
assert.equal(policy.provider, "render");
assert.equal(policy.serviceClass, "free-web-service");
assert.equal(policy.valueBearing, false);
assert.equal(policy.publicTestnetAuthorized, false);
assert.equal(policy.mainnetAuthorized, false);
assert.equal(policy.sustainedUptimeEvidence, false);
assert.equal(policy.multiHourSoakEvidence, false);
assert.equal(policy.independentFailureDomainEvidence, false);
assert.equal(policy.artificialKeepaliveForbidden, true);
assert.equal(policy.alwaysOnComputeRequiredForSustainedSoak, true);
uniqueStrings(policy.observedPlatformShutdowns, "observedPlatformShutdowns");
uniqueStrings(policy.permittedClaims, "permittedClaims");
uniqueStrings(policy.forbiddenClaims, "forbiddenClaims");
for (const timestamp of policy.observedPlatformShutdowns) assert.ok(Number.isFinite(Date.parse(timestamp)), `Invalid shutdown timestamp: ${timestamp}`);
for (const claim of [
  "sustained-testnet-uptime",
  "multi-hour-live-soak",
  "independent-operator-availability",
  "production-infrastructure",
  "public-testnet-readiness-from-render-free"
]) assert.ok(policy.forbiddenClaims.includes(claim), `Missing forbidden claim ${claim}`);

const docs = docsBytes.toString("utf8");
for (const text of [
  "Free Web Service",
  "smoke-only",
  "Do not add artificial keepalive",
  "always-on compute",
  "does not prove sustained testnet uptime",
  "public testnet or mainnet"
]) assert.ok(docs.includes(text), `Render profile docs missing safety text: ${text}`);

const result = {
  status: "ok",
  policyVersion: policy.policyVersion,
  policyStatus: policy.status,
  repository: process.env.GITHUB_REPOSITORY ?? "local-checkout",
  commitSha,
  publicTestnetAuthorized: false,
  mainnetAuthorized: false,
  sustainedUptimeEvidence: false,
  artificialKeepaliveForbidden: true,
  alwaysOnComputeRequiredForSustainedSoak: true,
  policySha256: sha256(policyBytes),
  docsSha256: sha256(docsBytes)
};
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
