#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { preflightCheckedInPublicTestnet } from "../dist/src/public-testnet-governance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const report = preflightCheckedInPublicTestnet({
  identity: await readJson(resolve(root, "config/public-testnet-identity.json")),
  bootstrap: await readJson(resolve(root, "config/public-testnet-bootstrap.json")),
  rpc: await readJson(resolve(root, "config/public-testnet-rpc.json")),
  minerProfile: await readJson(resolve(root, "miner-network-profile.json")),
  authorization: await readJson(resolve(repo, "docs/l1-launch-authorization.json")),
  governanceExample: await readJson(resolve(root, "config/public-testnet-governance-input.example.json"))
});

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.engineeringReadiness !== "PASS" || report.governanceActivation !== "BLOCKED" || report.activationFlagsFalse !== true) {
  process.exitCode = 1;
}
