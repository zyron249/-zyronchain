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
assert.ok(Array.isArray(policy.publicTestnetActivationRequirements) && policy.publicTestnetActivationRequirements.length >= 6);
assert.ok(Array.isArray(policy.mainnetActivationRequirements) && policy.mainnetActivationRequirements.length >= 8);

for (const gate of [
  "independent-consensus-cryptography-network-audit-and-retest",
  "sustained-independent-operator-internet-adversarial-soak",
  "production-hsm-or-audited-signer-custody-and-cross-host-rotation"
]) assert.ok(policy.publicTestnetActivationRequirements.includes(gate), `Missing public-testnet gate: ${gate}`);

for (const gate of [
  "immutable-mainnet-chain-id",
  "immutable-mainnet-genesis-allocation",
  "validator-reward-inflation-and-fee-policy",
  "activity-oracle-production-governance",
  "validator-admission-removal-governance"
]) assert.ok(policy.mainnetActivationRequirements.includes(gate), `Missing mainnet gate: ${gate}`);

const result = {
  status: "ok",
  publicTestnetAuthorized: true,
  mainnetAuthorized: true,
  publicTestnetActivationAllowed: false,
  mainnetActivationAllowed: false,
  activationStillEvidenceGated: true
};
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`, { flag: "wx", mode: 0o644 });
