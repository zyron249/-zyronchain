#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDomainRegistration, parseHostOperatorFile, parseRoleMatrix } from "../dist/src/public-testnet-operator-config.js";
import { parseOperatorInputPack } from "../dist/src/public-testnet-provisioning.js";
import { preflightCheckedInPublicTestnet } from "../dist/src/public-testnet-governance.js";
import { reviewConsensusSize, ROUND0_DOUBLE_HASH_CLASSIFICATION } from "../dist/src/public-testnet-consensus-review.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const authorization = await readJson(resolve(repo, "docs/l1-launch-authorization.json"));
const minerProfile = await readJson(resolve(root, "miner-network-profile.json"));
const identity = await readJson(resolve(root, "config/public-testnet-identity.json"));
const report = preflightCheckedInPublicTestnet({
  identity,
  bootstrap: await readJson(resolve(root, "config/public-testnet-bootstrap.json")),
  rpc: await readJson(resolve(root, "config/public-testnet-rpc.json")),
  minerProfile,
  authorization,
  governanceExample: await readJson(resolve(root, "config/public-testnet-governance-input.example.json")),
  governanceCandidate: await readJson(resolve(root, "config/public-testnet-governance-input.candidate.json"))
});
const pack = parseOperatorInputPack(await readJson(resolve(root, "config/public-testnet-operator-input.pack.json")));
const hosts = parseHostOperatorFile(await readJson(resolve(root, "config/public-testnet-hosts.operator.example.json")));
const domains = parseDomainRegistration(await readJson(resolve(root, "config/public-testnet-domains.operator.example.json")));
const matrix = parseRoleMatrix(await readJson(resolve(root, "deploy/public-testnet/role-matrix.json")));
const bom = await readJson(resolve(root, "deploy/public-testnet/bom.json"));
const n3 = reviewConsensusSize(3);
const n4 = reviewConsensusSize(4);
const n7 = reviewConsensusSize(7);

const summary = {
  network: report.networkIdentity.networkName,
  chainId: report.networkIdentity.chainId,
  genesis: report.networkIdentity.genesis,
  validators: report.networkIdentity.validators,
  bootstraps: report.networkIdentity.bootstraps,
  publicRpc: report.networkIdentity.publicRpc,
  archive: report.networkIdentity.archive,
  monitoring: report.networkIdentity.monitoring,
  mining: report.networkIdentity.mining,
  authorization: report.networkIdentity.authorization,
  flags: {
    publicTestnetActivationAllowed: authorization.publicTestnetActivationAllowed,
    mainnetActivationAllowed: authorization.mainnetActivationAllowed,
    publicMiningActivated: minerProfile.publicMiningActivated,
    publicationAllowed: identity.publicationAllowed
  },
  hostsFilled: hosts.filledHosts,
  domainsRegistered: domains.domains,
  logicalRoles: matrix.roles.length,
  minimumHosts: bom.minimumSafe.hostCount,
  recommendedHosts: bom.recommended.hostCount,
  operatorPack: pack.status,
  doubleHash: {
    classification: ROUND0_DOUBLE_HASH_CLASSIFICATION.activation,
    n3BothReachable: n3.bothHashesStillReachable,
    n4BothReachable: n4.bothHashesStillReachable,
    n7BothReachable: n7.bothHashesStillReachable,
    unsafeCompletion: n3.completionWhileBothReachable + n4.completionWhileBothReachable + n7.completionWhileBothReachable
  },
  soak: "NOT RUN"
};

process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
if (summary.flags.publicTestnetActivationAllowed !== false || summary.flags.mainnetActivationAllowed !== false ||
    summary.flags.publicMiningActivated !== false || summary.flags.publicationAllowed !== false ||
    identity.publicMiningActivated !== false ||
    summary.genesis !== "NOT BUILT" || summary.doubleHash.unsafeCompletion !== 0 || summary.hostsFilled !== 0) {
  process.exitCode = 1;
}
