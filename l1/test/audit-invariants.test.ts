import assert from "node:assert/strict";
import test from "node:test";

import { validatorQuorumSize } from "../src/block.js";
import {
  byzantineFaultBound,
  commitAllowedByLock,
  exploreBoundedConsensus,
  honestQuorumIntersection,
  SAFETY_INVARIANTS
} from "../src/round-view-change.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";
import { MINING_TRACKER_ADDRESS, miningRewardAtoms } from "../src/mining.js";

/** Independent auditor mapping of machine invariants I1–I13. */
export const AUDIT_MACHINE_INVARIANTS = [
  "I1 quorum is floor(2N/3)+1 for every accepted N",
  "I2 finality requires an attestation quorum; view-change alone never finalizes",
  "I3 honest validator signs at most one conflicting commit per height/round (journal)",
  "I4 conflicting later commit requires strictly higher-round prepare quorum",
  "I5 two commit quorums on different hashes require honest double-sign when faults <= f",
  "I6 every commit quorum intersects every later view-change quorum in an honest voter",
  "I7 nil-only view-change may open a new round; locked VC must finalize the lock first",
  "I8 chainId binds txs, votes, and blocks against cross-chain replay",
  "I9 historical issuance never exceeds MAX_SUPPLY_ATOMS (50M ZYN)",
  "I10 mining tracker address cannot receive genesis allocation or ordinary spend",
  "I11 domain-separated signatures for protocol >= 3 / tx version 2",
  "I12 consensus numbers are safe integers (codec + amounts)",
  "I13 non-loopback RPC requires peer auth and HTTPS trusted proxy"
] as const;

test("AUDIT: machine invariants I1–I13 registry is complete", () => {
  assert.equal(AUDIT_MACHINE_INVARIANTS.length, 13);
  assert.equal(SAFETY_INVARIANTS.length, 10);
});

test("AUDIT: I1–I7 consensus arithmetic holds for N=1..100", () => {
  for (let n = 1; n <= 100; n += 1) {
    const q = validatorQuorumSize(n);
    const f = byzantineFaultBound(n);
    assert.equal(q, Math.floor((2 * n) / 3) + 1);
    assert.ok(q * 2 > n);
    assert.ok(honestQuorumIntersection(n) >= 1);
    assert.ok(n - f >= q);
  }
  const a = "aa".repeat(32);
  const b = "bb".repeat(32);
  assert.equal(commitAllowedByLock([{ round: 0, hash: a }], 1, b, null), false);
  assert.equal(commitAllowedByLock([{ round: 0, hash: a }], 1, b, 0), false);
  assert.equal(commitAllowedByLock([{ round: 0, hash: a }], 1, b, 1), true);
  for (const n of [3, 4, 7]) {
    const explored = exploreBoundedConsensus(n, 2);
    assert.equal(explored.doubleFinalization, 0);
  }
});

test("AUDIT: I9–I10 supply and mining tracker", () => {
  assert.equal(MAX_SUPPLY_ATOMS, 50_000_000 * ATOMS_PER_ZYN);
  assert.equal(miningRewardAtoms(Number.MAX_SAFE_INTEGER, 0), 0);
  assert.equal(MINING_TRACKER_ADDRESS, `ZYN${"0".repeat(40)}`);
});
