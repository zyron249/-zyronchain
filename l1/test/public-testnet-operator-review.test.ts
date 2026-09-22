import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { hashCouldStillBeFinalized, validatorQuorumSize } from "../src/block.js";
import {
  ROUND0_DOUBLE_HASH_CLASSIFICATION,
  boundedCompletionChoice,
  enumerateDualHashObservations,
  reviewConsensusSize
} from "../src/public-testnet-consensus-review.js";
import {
  parseDomainRegistration,
  parseHostOperatorFile,
  parseRoleMatrix,
  validateOperatorDomainName
} from "../src/public-testnet-operator-config.js";

const execFileAsync = promisify(execFile);
const root = join(fileURLToPath(new URL(".", import.meta.url)), "../..");

test("round-0 double-hash search stays safety-closed for N=3, 4, and 7", () => {
  assert.equal(validatorQuorumSize(3), 3);
  assert.equal(validatorQuorumSize(4), 3);
  assert.equal(validatorQuorumSize(7), 5);
  const sizes = [3, 4, 7].map((count) => reviewConsensusSize(count));
  assert.equal(sizes[0]?.bothHashesStillReachable, 0);
  assert.equal(sizes[0]?.livenessClass, "impossible-under-bound");
  assert.ok((sizes[1]?.bothHashesStillReachable ?? 0) > 0);
  assert.ok((sizes[2]?.bothHashesStillReachable ?? 0) > 0);
  for (const size of sizes) {
    assert.equal(size.completionWhileBothReachable, 0);
    assert.equal(size.quorum, Math.floor((size.validatorCount * 2) / 3) + 1);
    assert.ok(size.uncommittedRevealThreshold >= 1);
  }
  for (const observation of [3, 4, 7].flatMap((count) => enumerateDualHashObservations(count))) {
    if (observation.reachableA && observation.reachableB) assert.equal(boundedCompletionChoice(observation), null);
  }
  assert.equal(hashCouldStillBeFinalized(1, 4, 4), false);
  assert.equal(ROUND0_DOUBLE_HASH_CLASSIFICATION.activation, "BLOCKS PUBLIC TESTNET");
});

test("operator matrix, host file, and domain file stay empty of real endpoints", async () => {
  const matrix = parseRoleMatrix(JSON.parse(await readFile(join(root, "deploy/public-testnet/role-matrix.json"), "utf8")));
  assert.equal(matrix.roles.length, 10);
  assert.equal(matrix.roles.filter((role) => role.mayHoldValidatorKey).length, 3);
  assert.equal(matrix.roles.find((role) => role.roleName === "rpc-a")?.mayHoldValidatorKey, false);
  assert.equal(matrix.roles.find((role) => role.roleName === "monitoring-a")?.exposesMetrics, true);
  const hosts = parseHostOperatorFile(JSON.parse(await readFile(join(root, "config/public-testnet-hosts.operator.example.json"), "utf8")));
  assert.equal(hosts.filledHosts, 0);
  const domains = parseDomainRegistration(JSON.parse(await readFile(join(root, "config/public-testnet-domains.operator.example.json"), "utf8")));
  assert.equal(domains.domains, 0);
  assert.throws(() => validateOperatorDomainName("rpc.example.com"), /not a real operator name/);
  const bom = JSON.parse(await readFile(join(root, "deploy/public-testnet/bom.json"), "utf8"));
  assert.equal(bom.pricing, null);
  assert.equal(bom.minimumSafe.hostCount, 7);
  assert.equal(bom.recommended.hostCount, 10);
  const terraform = await readFile(join(root, "deploy/public-testnet/terraform/variables.tf"), "utf8");
  assert.match(terraform, /sensitive\s+=\s+true/);
  assert.match(terraform, /Do not run terraform init or terraform apply/);
});

test("config-check, host preflight, install dry-run, and local plan stay fail-closed", async () => {
  const config = await execFileAsync(process.execPath, [join(root, "scripts/public-testnet-config-check.mjs")]);
  const summary = JSON.parse(config.stdout);
  assert.equal(summary.genesis, "NOT BUILT");
  assert.equal(summary.validators, "0/3");
  assert.equal(summary.flags.publicTestnetActivationAllowed, false);
  assert.equal(summary.flags.publicMiningActivated, false);
  assert.equal(summary.doubleHash.classification, "BLOCKS PUBLIC TESTNET");
  assert.equal(summary.doubleHash.unsafeCompletion, 0);
  assert.equal(summary.soak, "NOT RUN");
  const preflight = await execFileAsync(process.execPath, [join(root, "scripts/public-testnet-host-preflight.mjs"), "--role", "public-rpc"]);
  assert.equal(JSON.parse(preflight.stdout).started, false);
  const directory = await mkdtemp(join(tmpdir(), "zyron-preflight-"));
  const link = join(directory, "link");
  await symlink(directory, link);
  await assert.rejects(
    () => execFileAsync(process.execPath, [join(root, "scripts/public-testnet-host-preflight.mjs"), "--role", "validator", "--data", link]),
    /symlink/
  );
  await rm(directory, { recursive: true, force: true });
  const dry = await execFileAsync(process.execPath, [join(root, "scripts/public-testnet-install-dry-run.mjs")]);
  assert.equal(JSON.parse(dry.stdout).keysCreated, false);
  await assert.rejects(() => execFileAsync(process.execPath, [join(root, "scripts/public-testnet-install-dry-run.mjs"), "--start"]), /Refusing to start/);
  const plan = JSON.parse((await execFileAsync(process.execPath, [join(root, "scripts/public-testnet-local-rehearsal.mjs"), "--plan"])).stdout);
  assert.equal(plan.label, "LOCAL MULTIPROCESS REHEARSAL");
  assert.equal(plan.realRegions, false);
  assert.equal(plan.validators, 3);
  assert.equal(plan.publicMiningActivated, false);
  assert.notEqual(plan.chainId, "zyron-public-testnet-1");
});
