#!/usr/bin/env node
import { resolve } from "node:path";

import { readBoundedRegularControlFile } from "../dist/src/control-file.js";
import { ZyronChain } from "../dist/src/chain.js";
import { genesisConfigCommitment } from "../dist/src/block.js";
import { assertLaunchCeremonyNetworkClass } from "../dist/src/network-class.js";
import { assertFixedSupplyGenesis, FIXED_SUPPLY_LAUNCH_PROFILE } from "../dist/src/tokenomics.js";

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

// A launch genesis must use the fixed-supply launch profile so that consensus
// itself enforces these rules and the genesis hash binds the full configuration
// (docs/GENESIS_CONFIG_BINDING.md).
if (genesis === null || typeof genesis !== "object" || genesis.launchProfile !== FIXED_SUPPLY_LAUNCH_PROFILE) {
  throw new Error(`Fixed-supply launch genesis must declare launchProfile "${FIXED_SUPPLY_LAUNCH_PROFILE}"`);
}
// network-class-v1: the ceremony file must name a value-bearing class. Node
// start then refuses that class unless the fixed-supply profile (and therefore
// the founder and permanent-liquidity locks) is present.
assertLaunchCeremonyNetworkClass(genesis);
assertFixedSupplyGenesis(genesis, addresses);
// Full consensus genesis validation, including the allocation-lock declaration
// and the consensus launch-profile rules.
const chain = new ZyronChain(genesis);

console.log("Fixed-supply genesis validated.");
console.log("Total supply: 50,000,000 ZYN");
console.log("Founder: 5,000,000 ZYN (10%), on-chain vesting: 12-month cliff, 36-month linear");
console.log("Public distribution: 20,000,000 ZYN (40%)");
console.log("Permanent-liquidity reserve: 20,000,000 ZYN (40%), on-chain locked: no outflow");
console.log("Ecosystem reserve: 5,000,000 ZYN (10%)");
console.log("Mining issuance headroom: 0 ZYN");
console.log(`Launch profile: ${FIXED_SUPPLY_LAUNCH_PROFILE}`);
console.log(`Network class: ${genesis.networkClass}`);
const release = genesis.publicDistributionRelease;
if (release && typeof release === "object") {
  console.log(`Public distribution release: cliffMs=${release.cliffMs} linearMs=${release.linearMs} address=${release.address}`);
  console.log("Public distribution schedule: PENDING REVIEW (owner product decision). Documented conservative default: 90-day cliff, then 1,095-day linear release. Day one stays locked.");
}
console.log(`Genesis configuration commitment: ${genesisConfigCommitment(genesis)}`);
console.log(`Genesis hash (chain identity): ${chain.genesisHash}`);
