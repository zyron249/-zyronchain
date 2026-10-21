// EXT-04 residual, PR B: the retired `mining_claim` kind keeps an explicit,
// early, fail-closed rejection with the exact stable message, but the state
// appliers no longer carry any mining issuance logic (credit, nonce or
// tracker-counter updates). The observable outcome is pinned unchanged by
// test/mining-claim-rejection-pin.test.ts; this file pins that the applier
// bodies themselves are reduced to the rejection.
import assert from "node:assert/strict";
import test from "node:test";

import * as chainModule from "../src/chain.js";
import * as miningModule from "../src/mining.js";
import { MINING_RETIRED_MESSAGE, MINING_TRACKER_ADDRESS } from "../src/mining.js";
import { LedgerState } from "../src/state.js";

// Any of these in an applier body means it can still move balances, nonces
// or the claim counter (the pre-retirement issuance path).
const ISSUANCE_TOKENS = [
  /\bcredit\w*\s*\(/,
  /\bsetNonce\w*\s*\(/,
  /\brequireNonce\w*\s*\(/,
  /\.set\s*\(/,
  /\brewardAtoms\b/,
  /\bminingClaimCount\s*\(/,
  /\bstateV2(Balance|Nonce)\s*\(/,
  /\btotalSupplyAtoms\s*\(/,
  /MAX_SUPPLY_ATOMS/
];

function assertRejectionOnly(source: string, label: string): void {
  for (const token of ISSUANCE_TOKENS) {
    assert.doesNotMatch(source, token, `${label} still contains mining issuance logic (${token})`);
  }
  assert.match(source, /rejectRetiredMiningClaim\s*\(/, `${label} must reject through rejectRetiredMiningClaim`);
}

function throwsExactly(fn: () => unknown, label: string): void {
  let thrown: unknown;
  try { fn(); } catch (error) { thrown = error; }
  assert.ok(thrown instanceof Error, `${label}: expected an Error`);
  assert.equal(thrown.message, MINING_RETIRED_MESSAGE, `${label}: unexpected message`);
}

// Looked up at run time so a missing export fails this test, not the build.
const rejectRetiredMiningClaim = (miningModule as unknown as Record<string, unknown>).rejectRetiredMiningClaim as (() => never) | undefined;

test("rejectRetiredMiningClaim always throws the exact retired message", () => {
  assert.equal(typeof rejectRetiredMiningClaim, "function", "mining.ts must export rejectRetiredMiningClaim");
  throwsExactly(() => rejectRetiredMiningClaim!(), "rejectRetiredMiningClaim");
});

test("the legacy LedgerState mining applier body is the rejection only", () => {
  const applier = (LedgerState.prototype as unknown as Record<string, unknown>).applyMining;
  assert.equal(typeof applier, "function", "legacy mining applier must stay (explicit rejection)");
  assertRejectionOnly(String(applier), "LedgerState.applyMining");
});

test("the chain-context State-v2 mining applier body is the rejection only", () => {
  const applier = (chainModule as unknown as Record<string, unknown>).applyMiningClaimStateV2;
  assert.equal(typeof applier, "function", "chain-context State-v2 mining applier must stay (explicit rejection)");
  assertRejectionOnly(String(applier), "applyMiningClaimStateV2");
});

test("appliers reject before reading any state (no state access at all)", () => {
  const untouchable = new Proxy({}, { get() { throw new Error("state was read"); } });
  const applier = (chainModule as unknown as Record<string, (state: unknown, tx: unknown) => unknown>).applyMiningClaimStateV2!;
  throwsExactly(() => applier(untouchable, untouchable), "applyMiningClaimStateV2 with untouchable inputs");
  const legacy = (LedgerState.prototype as unknown as Record<string, (tx: unknown) => unknown>).applyMining!;
  throwsExactly(() => legacy.call(untouchable, untouchable), "LedgerState.applyMining with untouchable inputs");
});

test("the mining tracker address stays protocol-reserved and unchanged", () => {
  assert.equal(MINING_TRACKER_ADDRESS, `ZYN${"0".repeat(40)}`);
});
