#!/usr/bin/env node
import { resolve } from "node:path";

import { readBoundedRegularControlFile } from "../dist/src/control-file.js";
import { assertFixedSupplyGenesis } from "../dist/src/tokenomics.js";

const MAX_GENESIS_BYTES = 256 * 1024;

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`Missing required option ${name}`);
  return process.argv[index + 1];
}

const genesisPath = resolve(option("--genesis"));
const text = await readBoundedRegularControlFile(
  genesisPath,
  "Fixed-supply genesis file",
  MAX_GENESIS_BYTES
);

let genesis;
try {
  genesis = JSON.parse(text);
} catch {
  throw new Error("Fixed-supply genesis file contains invalid JSON");
}

const addresses = {
  founder: option("--founder"),
  publicDistribution: option("--public-distribution"),
  liquidityReserve: option("--liquidity-reserve"),
  ecosystemReserve: option("--ecosystem-reserve")
};

assertFixedSupplyGenesis(genesis, addresses);

console.log("Fixed-supply genesis validated.");
console.log("Total supply: 50,000,000 ZYN");
console.log("Founder: 5,000,000 ZYN (10%)");
console.log("Public distribution: 20,000,000 ZYN (40%)");
console.log("Permanent-liquidity reserve: 20,000,000 ZYN (40%)");
console.log("Ecosystem reserve: 5,000,000 ZYN (10%)");
console.log("Mining issuance headroom: 0 ZYN");
