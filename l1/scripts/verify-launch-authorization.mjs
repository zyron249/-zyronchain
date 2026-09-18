#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const policyPath = option("--policy");
const outPath = option("--out");
const policy = JSON.parse(await readFile(policyPath, "utf8"));

assert.equal(policy.authorizationVersion, 1);
assert.equal(policy.status, "governance-authorization-granted-activation-gated");
assert.equal(policy.canonicalImplementation, "l1/");
assert.equal(policy.publicTestnetAuthorized, true);
assert.equal(policy.mainnetAuthorized, true);
assert.equal(policy.publicTestnetActivationAllowed, false);
assert.equal(policy.mainnetActivationAllowed, false);
assert.equal(policy.authorizationDoesNotWaiveReadinessGates, true);
for (const field of ["publicTestnetActivationRequirements", "mainnetActivationRequirements"]) {
  assert.ok(Array.isArray(policy[field]), `${field} must be an array`);
  assert.ok(policy[field].every((gate) => typeof gate === "string" && gate.length > 0), `${field} contains an invalid gate`);
  assert.equal(new Set(policy[field]).size, policy[field].length, `${field} contains duplicate gates`);
}

for (const gate of [
  "independent-operators-deploy-from-release-artifacts-without-founder-assistance",
  "bootstrap-archive-monitoring-across-independent-failure-domains",
  "independent-consensus-cryptography-network-audit-and-retest",
  "sustained-independent-operator-internet-adversarial-soak",
  "production-hsm-or-audited-signer-custody-and-cross-host-rotation",
  "protected-branch-independent-review-repository-policy",
  "target-hardware-state-v2-scale-and-recovery-measurements",
  "independent-maintainer-and-security-custody-succession-evidence",
  "independent-mining-contention-target-calibration-and-retest"
]) assert.ok(policy.publicTestnetActivationRequirements.includes(gate), `Missing public-testnet gate: ${gate}`);

for (const gate of [
  "all-public-testnet-activation-requirements-closed-with-evidence",
  "immutable-mainnet-chain-id",
  "immutable-mainnet-genesis-allocation",
  "validator-reward-inflation-and-fee-policy",
  "activity-oracle-production-governance",
  "validator-admission-removal-governance",
  "target-hardware-state-v2-scale-and-recovery-measurements",
  "multi-region-disaster-recovery-and-incident-drills",
  "independent-maintainer-and-security-custody-succession-evidence"
]) assert.ok(policy.mainnetActivationRequirements.includes(gate), `Missing mainnet gate: ${gate}`);

const result = {
  status: "ok",
  resultKind: "policy-consistency-only",
  launchReadinessVerified: false,
  publicTestnetRequiredGateCount: policy.publicTestnetActivationRequirements.length,
  mainnetRequiredGateCount: policy.mainnetActivationRequirements.length,
  publicTestnetAuthorized: true,
  mainnetAuthorized: true,
  publicTestnetActivationAllowed: false,
  mainnetActivationAllowed: false,
  activationStillEvidenceGated: true
};
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
