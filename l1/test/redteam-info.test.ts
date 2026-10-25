// Red Team Session 1 INFO items #5, #8 and #9: a read-only supply report,
// replay error text that names the real cause, and a faucet nonce that
// resyncs from chain state after a restore. No consensus rule changes.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertMempoolSenderNonce } from "../src/fee-policy.js";
import { supplyReport, type SupplySource } from "../src/supply-report.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Address } from "../src/types.js";

const l1Root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const faucetNonce: any = await import(pathToFileURL(join(l1Root, "scripts", "faucet-nonce.mjs")).href);

const a = (n: number) => `ZYN${n.toString(16).padStart(40, "0")}` as Address;
const ZYN = ATOMS_PER_ZYN;

function source(balances: number[], genesisSupply = MAX_SUPPLY_ATOMS, lockedOf: (address: Address, balance: number) => number = () => 0): SupplySource {
  return {
    height: 7,
    tipHash: "ab".repeat(32),
    genesisSupplyAtoms: () => genesisSupply,
    accounts: () => balances.map((balanceAtoms, index) => ({ address: a(index + 1), balanceAtoms })),
    lockedAtoms: lockedOf
  };
}

test("supply report: fixed 50M total as a string, burned derived from state, reconciles", () => {
  const report = supplyReport(source([40_000_000 * ZYN, 9_000_000 * ZYN, 999_000 * ZYN]));
  assert.equal(report.totalSupplyAtoms, "5000000000000000");
  assert.equal(report.maxSupplyAtoms, String(MAX_SUPPLY_ATOMS));
  assert.equal(report.balancesAtoms, String(49_999_000 * ZYN));
  assert.equal(report.burnedAtoms, String(1_000 * ZYN));
  assert.equal(report.pendingAtoms, "0");
  assert.equal(report.reconciles, true);
  assert.equal(BigInt(report.balancesAtoms) + BigInt(report.pendingAtoms) + BigInt(report.burnedAtoms), BigInt(report.totalSupplyAtoms));
  assert.equal(report.height, 7);
});

test("supply report: locked is a subset of balances and circulating = balances - locked", () => {
  const report = supplyReport(source([30_000_000 * ZYN, 20_000_000 * ZYN], MAX_SUPPLY_ATOMS, (address, balance) => address === a(1) ? balance - 1 * ZYN : 0));
  assert.equal(report.lockedAtoms, String(29_999_999 * ZYN));
  assert.equal(report.circulatingAtoms, String(20_000_001 * ZYN));
  assert.equal(report.burnedAtoms, "0");
});

test("supply report: balances above the genesis supply do not reconcile (fail closed, no negative burn)", () => {
  const report = supplyReport(source([MAX_SUPPLY_ATOMS, 1]));
  assert.equal(report.reconciles, false);
  assert.equal(report.burnedAtoms, null);
});

test("replay error: a used nonce names the replay, a far-future nonce keeps the window text", () => {
  assert.throws(() => assertMempoolSenderNonce(3, 5), /nonce already used.*replayed or stale/);
  assert.throws(() => assertMempoolSenderNonce(5, 5), /nonce already used/);
  assert.throws(() => assertMempoolSenderNonce(70, 5), /nonce outside mempool window/);
  assert.doesNotThrow(() => assertMempoolSenderNonce(6, 5));
});

test("faucet nonce: resyncs from chain state when the chain nonce goes backwards (restore)", () => {
  const tracker = faucetNonce.createFaucetNonceTracker();
  const t0 = 1_000_000;
  assert.equal(tracker.next(40, t0), 41); tracker.accepted(41, t0);
  assert.equal(tracker.next(40, t0 + 1_000), 42); tracker.accepted(42, t0 + 1_000);
  // Snapshot restore rewinds the faucet account to nonce 0 within 3 minutes.
  assert.equal(tracker.next(0, t0 + 2_000), 1);
});

test("faucet nonce: a rejected drip drops the local cache so the next one uses chain state", () => {
  const tracker = faucetNonce.createFaucetNonceTracker();
  assert.equal(tracker.next(10, 0), 11); tracker.accepted(11, 0);
  assert.equal(tracker.next(10, 10), 12);
  tracker.rejected();
  assert.equal(tracker.next(10, 20), 11);
});

test("faucet nonce: stale cache expires and invalid chain nonces fail closed", () => {
  const tracker = faucetNonce.createFaucetNonceTracker();
  assert.equal(tracker.next(5, 0), 6); tracker.accepted(6, 0);
  assert.equal(tracker.next(5, 180_001), 6);
  assert.throws(() => tracker.next(-1, 0), /invalid/);
  assert.throws(() => tracker.next(1.5, 0), /invalid/);
});
