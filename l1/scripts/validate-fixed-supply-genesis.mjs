#!/usr/bin/env node
import { resolve } from "node:path";

import { readBoundedRegularControlFile } from "../dist/src/control-file.js";
import { validateGenesisBeforePossessionProofs, ZyronChain } from "../dist/src/chain.js";
import { genesisConfigCommitment } from "../dist/src/block.js";
import { assertLaunchCeremonyNetworkClass } from "../dist/src/network-class.js";
import { assertFixedSupplyGenesis, FIXED_SUPPLY_LAUNCH_PROFILE } from "../dist/src/tokenomics.js";
import { POSSESSION_PROOF_DOMAIN } from "../dist/src/validator-admission.js";

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

// P1-07 ceremony order: (1) precheck with `--before-possession-proofs` on the
// genesis whose validatorAdmission.genesisProofs is empty; (2) each validator
// operator signs the printed chain binding locally; (3) this command again,
// without the flag, on the file with every proof. Only (3) is the final check.
if (process.argv.includes("--before-possession-proofs")) {
  validateGenesisBeforePossessionProofs(genesis);
  const binding = genesisConfigCommitment(genesis);
  console.log("PRECHECK ONLY (before validator possession proofs). This is not the final ceremony check.");
  console.log("Every genesis rule except the possession proofs passed.");
  console.log(`Possession proof domain: ${POSSESSION_PROOF_DOMAIN}`);
  console.log(`Possession proof chain binding (genesis configuration commitment): ${binding}`);
  console.log(`Possession proof payload per validator: { chainId: "${genesis.chainId}", chainBinding: "${binding}", activationHeight: 0, address, publicKey }`);
  console.log("Next: collect one proof per validator, in validator order, then run this command again without --before-possession-proofs.");
  process.exit(0);
}

// Full consensus genesis validation, including the allocation-lock declaration,
// the consensus launch-profile rules and the validator possession proofs.
const chain = new ZyronChain(genesis);

console.log("Fixed-supply genesis validated.");
console.log("Total supply: 50,000,000 ZYN");
console.log("Founder: 5,000,000 ZYN (10%), on-chain vesting: 12-month cliff, 36-month linear");
console.log("Public distribution: 20,000,000 ZYN (40%)");
console.log("Permanent-liquidity reserve: 20,000,000 ZYN (40%), on-chain locked: no outflow");
console.log("Ecosystem reserve: 5,000,000 ZYN (10%)");
console.log("Mining issuance headroom: 0 ZYN");
console.log(`Launch profile: ${FIXED_SUPPLY_LAUNCH_PROFILE}`);
if (genesis.feePolicy && typeof genesis.feePolicy === "object") {
  console.log(`Fee policy: ${genesis.feePolicy.version} fixedTransferFeeAtoms=${genesis.feePolicy.fixedTransferFeeAtoms}`);
} else {
  console.log("Fee policy: absent (historical full burn; fixed-fee-v1 is not activated on this file)");
}
console.log(`Network class: ${genesis.networkClass}`);
const release = genesis.publicDistributionRelease;
if (release && typeof release === "object") {
  console.log(`Public distribution release: cliffMs=${release.cliffMs} linearMs=${release.linearMs} address=${release.address}`);
  console.log("Public distribution schedule: decided by owner. Default is no cliff (cliffMs=0) and a 365-day linear release (linearMs=31536000000). Day one releases only the accrued linear slice, not the full allocation.");
}
console.log(`Genesis configuration commitment: ${genesisConfigCommitment(genesis)}`);
console.log(`Genesis hash (chain identity): ${chain.genesisHash}`);
