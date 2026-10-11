#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const path = resolve(process.argv[2] ?? "../docs/fixed-supply-launch-plan.json");
const raw = await readFile(path, "utf8");
const plan = JSON.parse(raw);

const failures = [];
if (plan?.version !== 1) failures.push("unsupported launch-plan version");
if (plan?.status !== "activation-approved") failures.push("status is not activation-approved");
if (plan?.totalSupply !== "50000000") failures.push("total supply is not exactly 50,000,000");

const allocation = plan?.allocations ?? {};
const expected = {
  founder: ["5000000", 1000],
  publicDistribution: ["20000000", 4000],
  permanentLiquidityReserve: ["20000000", 4000],
  ecosystemCommunity: ["5000000", 1000]
};
for (const [name, [amount, shareBps]] of Object.entries(expected)) {
  if (allocation[name]?.amount !== amount || allocation[name]?.shareBps !== shareBps) {
    failures.push(`${name} allocation does not match the frozen plan`);
  }
}

if (plan?.founderVesting?.earlyUnlockAllowed !== false) failures.push("founder early unlock is not disabled");
if (plan?.founderVesting?.consensusEnforcementImplemented !== true) failures.push("founder vesting is not consensus-enforced");
if (plan?.amm?.adminLiquidityWithdrawal !== false) failures.push("admin liquidity withdrawal is not disabled");
if (plan?.amm?.lpTokens !== false) failures.push("LP-token withdrawal surface is enabled");
if (typeof plan?.amm?.quoteAsset !== "string" || plan.amm.quoteAsset.length < 1) failures.push("quote asset is not frozen");
if (plan?.amm?.productionImplementationActivated !== true) failures.push("production AMM is not activated");
if (plan?.sale?.websiteTradingActivated !== true) failures.push("website trading is not activated");
if (plan?.sale?.custodialFounderReceiptOfBuyerFunds !== false) failures.push("buyer funds may be routed to founder custody");
if (plan?.sale?.productionImplementationActivated !== true) failures.push("production sale implementation is not activated");

for (const [gate, value] of Object.entries(plan?.activationGates ?? {})) {
  if (value !== true) failures.push(`activation gate remains false: ${gate}`);
}

if (failures.length) {
  console.error("Zyron trading activation REFUSED.");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(2);
}

console.log("Zyron trading activation preflight passed.");
