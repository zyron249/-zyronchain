import assert from "node:assert/strict";
import test from "node:test";

import { validatorQuorumSize } from "../src/block.js";
import {
  byzantineFaultBound,
  commitAllowedByLock,
  exploreBoundedConsensus,
  honestQuorumIntersection,
  roundChangeLivenessBound,
  SAFETY_INVARIANTS
} from "../src/round-view-change.js";

test("S1–S10 stay bound to quorum, locks, and the bounded search", () => {
  assert.deepEqual([...SAFETY_INVARIANTS], [
    "S1 quorum is floor(2N/3)+1 and is never lowered",
    "S2 a hash finalizes only with a commit quorum of finality attestations",
    "S3 an honest validator commits at most one hash in a round",
    "S4 an honest validator commits a fresh hash only after a prepare quorum, or on the unique-hash completion path",
    "S5 a conflicting later commit requires a prepare quorum from a strictly higher round",
    "S6 two commit quorums on different hashes require an honest double-sign when faults are at most f",
    "S7 every view-change quorum intersects the honest committers of a commit quorum",
    "S8 a new-round proposal is accepted only for a nil-lock view-change certificate",
    "S9 timeout and view-change votes do not finalize a hash",
    "S10 journal and lock-certificate bytes are durable before the signature is returned"
  ]);
  for (let count = 1; count <= 100; count += 1) {
    const quorum = validatorQuorumSize(count);
    assert.equal(quorum, Math.floor((count * 2) / 3) + 1);
    assert.ok(quorum * 2 > count);
    assert.ok(honestQuorumIntersection(count) >= 1);
    assert.equal(roundChangeLivenessBound(count), byzantineFaultBound(count) + 1);
    assert.ok(count - byzantineFaultBound(count) >= quorum);
  }
  const hashA = "aa".repeat(32);
  const hashB = "bb".repeat(32);
  assert.equal(commitAllowedByLock([{ round: 0, hash: hashA }], 1, hashB, null), false);
  assert.equal(commitAllowedByLock([{ round: 0, hash: hashA }], 1, hashB, 0), false);
  assert.equal(commitAllowedByLock([{ round: 0, hash: hashA }], 1, hashB, 1), true);
  assert.equal(commitAllowedByLock([{ round: 0, hash: hashA }], 1, hashA, 0), true);
  for (const count of [3, 4, 7]) {
    const explored = exploreBoundedConsensus(count, 2);
    assert.equal(explored.doubleFinalization, 0, `double finalization at N=${count}`);
    assert.equal(explored.conflictingCertificates, 0, `conflicting certificates at N=${count}`);
    assert.equal(explored.permanentDeadlockAfterRecovery, 0, `deadlock at N=${count}`);
    assert.equal(explored.invalidUnlock, 0, `invalid unlock at N=${count}`);
    assert.equal(explored.journalLoss, 0, `journal loss at N=${count}`);
    assert.equal(explored.livenessFailures, 0, `liveness failure at N=${count}`);
    assert.ok(explored.assignments > 0);
  }
});
