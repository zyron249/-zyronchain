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

function hex(value, bytes, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.match(value, new RegExp(`^[0-9a-f]{${bytes * 2}}$`), `${label} must be lowercase hex`);
}

function timestamp(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  const parsed = Date.parse(value);
  assert.ok(Number.isFinite(parsed), `${label} must be RFC3339/ISO-8601 UTC time`);
  return parsed;
}

function uniqueStrings(values, label, minimum = 1) {
  assert.ok(Array.isArray(values) && values.length >= minimum, `${label} requires at least ${minimum} entries`);
  for (const value of values) {
    assert.equal(typeof value, "string", `${label} entries must be strings`);
    assert.match(value, /^[A-Za-z0-9._:-]{2,128}$/, `${label} entry is invalid`);
  }
  assert.equal(new Set(values).size, values.length, `${label} contains duplicates`);
}

const policyPath = option("--policy");
const evidencePath = option("--evidence");
const outputPath = option("--out");
const testVectorMode = process.argv.includes("--test-vector");

const policy = JSON.parse(await readFile(policyPath, "utf8"));
exactKeys(policy, [
  "policyVersion", "status", "minimumRealDurationSeconds", "maximumFinalityGapSeconds",
  "maximumMemoryUtilizationPercent", "minimumReadyValidators", "minimumTotalValidators",
  "sameGenesisRequired", "monotonicHeightRequired", "unaccountedRestartsForbidden",
  "clockFaultsForbidden", "persistenceFaultsForbidden", "syntheticVectorsCannotProveSoak",
  "independentOperatorEvidenceSeparate", "mainnetCertificationForbidden"
], "hosted duration-soak policy");
assert.equal(policy.policyVersion, 1);
assert.equal(policy.status, "prepared-real-always-on-evidence-required");
assert.ok(Number.isSafeInteger(policy.minimumRealDurationSeconds) && policy.minimumRealDurationSeconds >= 3600);
assert.ok(Number.isFinite(policy.maximumFinalityGapSeconds) && policy.maximumFinalityGapSeconds > 0);
assert.ok(Number.isFinite(policy.maximumMemoryUtilizationPercent) && policy.maximumMemoryUtilizationPercent > 0 && policy.maximumMemoryUtilizationPercent < 100);
assert.ok(Number.isSafeInteger(policy.minimumReadyValidators) && policy.minimumReadyValidators >= 1);
assert.ok(Number.isSafeInteger(policy.minimumTotalValidators) && policy.minimumTotalValidators >= policy.minimumReadyValidators);
for (const field of [
  "sameGenesisRequired", "monotonicHeightRequired", "unaccountedRestartsForbidden",
  "clockFaultsForbidden", "persistenceFaultsForbidden", "syntheticVectorsCannotProveSoak",
  "independentOperatorEvidenceSeparate", "mainnetCertificationForbidden"
]) assert.equal(policy[field], true, `${field} must remain fail-closed`);

const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
exactKeys(evidence, [
  "evidenceVersion", "evidenceMode", "testedCommitSha", "releaseArtifactSha256",
  "chainId", "genesisHash", "provider", "region", "failureDomains", "startedAtUtc",
  "completedAtUtc", "samples", "restartEvents", "notes"
], "hosted duration-soak evidence");
assert.equal(evidence.evidenceVersion, 1);
const expectedMode = testVectorMode ? "synthetic-test-vector" : "hosted-duration-soak";
assert.equal(evidence.evidenceMode, expectedMode, `Evidence mode must be ${expectedMode}`);
hex(evidence.testedCommitSha, 20, "testedCommitSha");
hex(evidence.releaseArtifactSha256, 32, "releaseArtifactSha256");
hex(evidence.genesisHash, 32, "genesisHash");
assert.match(evidence.chainId, /^[a-z0-9-]{3,64}$/, "Invalid chainId");
assert.match(evidence.provider, /^[A-Za-z0-9._ -]{2,128}$/, "Invalid provider");
assert.match(evidence.region, /^[A-Za-z0-9._:-]{2,128}$/, "Invalid region");
uniqueStrings(evidence.failureDomains, "failureDomains");

const started = timestamp(evidence.startedAtUtc, "startedAtUtc");
const completed = timestamp(evidence.completedAtUtc, "completedAtUtc");
assert.ok(completed > started, "completedAtUtc must be after startedAtUtc");
const durationSeconds = Math.floor((completed - started) / 1000);
assert.ok(durationSeconds >= policy.minimumRealDurationSeconds, `Soak duration ${durationSeconds}s is below policy minimum ${policy.minimumRealDurationSeconds}s`);

assert.ok(Array.isArray(evidence.samples) && evidence.samples.length >= 3, "At least three soak samples are required");
let previousTime = -Infinity;
let previousHeight = -1;
let previousTipHash;
let firstHeight;
let maxFinalityGapSeconds = 0;
let peakMemoryUtilizationPercent = 0;

for (let index = 0; index < evidence.samples.length; index += 1) {
  const sample = evidence.samples[index];
  exactKeys(sample, [
    "observedAtUtc", "height", "tipHash", "readyValidators", "totalValidators",
    "finalityGapSeconds", "memoryUsedBytes", "memoryLimitBytes", "clockFaultCount", "persistenceFaultCount"
  ], `samples[${index}]`);
  const observed = timestamp(sample.observedAtUtc, `samples[${index}].observedAtUtc`);
  assert.ok(observed >= started && observed <= completed, `samples[${index}] lies outside the soak range`);
  assert.ok(observed > previousTime, `samples[${index}] timestamp is not strictly increasing`);
  previousTime = observed;

  assert.ok(Number.isSafeInteger(sample.height) && sample.height >= 1, `samples[${index}].height is invalid`);
  hex(sample.tipHash, 32, `samples[${index}].tipHash`);
  if (index === 0) firstHeight = sample.height;
  if (policy.monotonicHeightRequired) assert.ok(sample.height >= previousHeight, `samples[${index}] finalized height regressed`);
  if (sample.height === previousHeight) assert.equal(sample.tipHash, previousTipHash, `samples[${index}] changed tip hash at the same finalized height`);
  previousHeight = sample.height;
  previousTipHash = sample.tipHash;

  assert.ok(Number.isSafeInteger(sample.totalValidators) && sample.totalValidators >= policy.minimumTotalValidators, `samples[${index}].totalValidators is below policy minimum`);
  assert.ok(Number.isSafeInteger(sample.readyValidators) && sample.readyValidators >= 0 && sample.readyValidators <= sample.totalValidators, `samples[${index}].readyValidators is invalid`);
  assert.ok(sample.readyValidators * policy.minimumTotalValidators >= policy.minimumReadyValidators * sample.totalValidators, `samples[${index}] validator readiness is below the ${policy.minimumReadyValidators}/${policy.minimumTotalValidators} policy fraction`);

  assert.ok(Number.isFinite(sample.finalityGapSeconds) && sample.finalityGapSeconds >= 0, `samples[${index}].finalityGapSeconds is invalid`);
  assert.ok(sample.finalityGapSeconds <= policy.maximumFinalityGapSeconds, `samples[${index}] finality gap exceeds policy maximum`);
  maxFinalityGapSeconds = Math.max(maxFinalityGapSeconds, sample.finalityGapSeconds);

  assert.ok(Number.isSafeInteger(sample.memoryUsedBytes) && sample.memoryUsedBytes >= 0, `samples[${index}].memoryUsedBytes is invalid`);
  assert.ok(Number.isSafeInteger(sample.memoryLimitBytes) && sample.memoryLimitBytes > 0, `samples[${index}].memoryLimitBytes is invalid`);
  assert.ok(sample.memoryUsedBytes <= sample.memoryLimitBytes, `samples[${index}] memory usage exceeds the declared limit`);
  const memoryPercent = (sample.memoryUsedBytes / sample.memoryLimitBytes) * 100;
  assert.ok(memoryPercent <= policy.maximumMemoryUtilizationPercent, `samples[${index}] memory utilization exceeds policy maximum`);
  peakMemoryUtilizationPercent = Math.max(peakMemoryUtilizationPercent, memoryPercent);

  assert.ok(Number.isSafeInteger(sample.clockFaultCount) && sample.clockFaultCount >= 0, `samples[${index}].clockFaultCount is invalid`);
  assert.ok(Number.isSafeInteger(sample.persistenceFaultCount) && sample.persistenceFaultCount >= 0, `samples[${index}].persistenceFaultCount is invalid`);
  if (policy.clockFaultsForbidden) assert.equal(sample.clockFaultCount, 0, `samples[${index}] records a clock fault`);
  if (policy.persistenceFaultsForbidden) assert.equal(sample.persistenceFaultCount, 0, `samples[${index}] records a persistence fault`);
}

assert.ok(previousHeight > firstHeight, "Soak evidence must demonstrate finalized-height progress");

assert.ok(Array.isArray(evidence.restartEvents), "restartEvents must be an array");
for (let index = 0; index < evidence.restartEvents.length; index += 1) {
  const event = evidence.restartEvents[index];
  exactKeys(event, [
    "observedAtUtc", "reason", "accounted", "sameDataRecovery", "genesisPreserved", "finalityResumed"
  ], `restartEvents[${index}]`);
  const observed = timestamp(event.observedAtUtc, `restartEvents[${index}].observedAtUtc`);
  assert.ok(observed >= started && observed <= completed, `restartEvents[${index}] lies outside the soak range`);
  assert.equal(typeof event.reason, "string");
  assert.ok(event.reason.length >= 3 && event.reason.length <= 256, `restartEvents[${index}].reason is invalid`);
  if (policy.unaccountedRestartsForbidden) assert.equal(event.accounted, true, `restartEvents[${index}] is unaccounted`);
  assert.equal(event.sameDataRecovery, true, `restartEvents[${index}] did not preserve same-data recovery`);
  if (policy.sameGenesisRequired) assert.equal(event.genesisPreserved, true, `restartEvents[${index}] did not preserve genesis identity`);
  assert.equal(event.finalityResumed, true, `restartEvents[${index}] did not resume finality`);
}

assert.equal(typeof evidence.notes, "string");
assert.ok(evidence.notes.length <= 4_000, "Evidence notes are too long");

const result = {
  status: "ok",
  evidenceVersion: evidence.evidenceVersion,
  evidenceMode: evidence.evidenceMode,
  testedCommitSha: evidence.testedCommitSha,
  chainId: evidence.chainId,
  genesisHash: evidence.genesisHash,
  provider: evidence.provider,
  region: evidence.region,
  declaredFailureDomainCount: evidence.failureDomains.length,
  durationSeconds,
  sampleCount: evidence.samples.length,
  startHeight: firstHeight,
  endHeight: previousHeight,
  maxFinalityGapSeconds,
  peakMemoryUtilizationPercent: Number(peakMemoryUtilizationPercent.toFixed(3)),
  restartEventCount: evidence.restartEvents.length,
  syntheticValidationOnly: testVectorMode,
  sustainedUptimeEvidenceValidated: !testVectorMode,
  publicTestnetActivationEvidence: !testVectorMode,
  independentOperatorEvidenceProven: false,
  externalReviewRequired: true,
  mainnetCertified: false
};

await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
