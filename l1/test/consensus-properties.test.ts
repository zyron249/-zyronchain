import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatorQuorumSize } from "../src/block.js";
import { SigningJournal } from "../src/storage.js";

test("property: every pair of finality quorums intersects in more validators than the Byzantine bound", () => {
  // Exhaust every quorum subset for practical validator counts. If at most f
  // validators are Byzantine, an intersection larger than f necessarily
  // contains an honest validator that the anti-equivocation journal prevents
  // from voting for two conflicting blocks in one consensus slot.
  for (let validatorCount = 1; validatorCount <= 10; validatorCount += 1) {
    const quorum = validatorQuorumSize(validatorCount);
    const maxByzantine = Math.floor((validatorCount - 1) / 3);
    const masks: number[] = [];
    for (let mask = 0; mask < (1 << validatorCount); mask += 1) {
      if (popcount(mask) >= quorum) masks.push(mask);
    }
    for (const left of masks) {
      for (const right of masks) {
        assert.ok(
          popcount(left & right) > maxByzantine,
          `unsafe quorum intersection for n=${validatorCount}, q=${quorum}`
        );
      }
    }
  }

  // Cover large configured sets without exponential enumeration. The exact
  // minimum intersection of two q-sized subsets is max(0, 2q-n).
  for (let validatorCount = 11; validatorCount <= 10_000; validatorCount += 1) {
    const quorum = validatorQuorumSize(validatorCount);
    const maxByzantine = Math.floor((validatorCount - 1) / 3);
    assert.ok((2 * quorum) - validatorCount > maxByzantine);
  }
});

test("model: signing journal matches fail-closed first-choice semantics across randomized restart traces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-signing-model-"));
  let journal = await SigningJournal.open(directory);
  const model = new Map<string, string>();
  let seed = 0x7a91c0de;
  try {
    for (let step = 0; step < 300; step += 1) {
      seed = next(seed);
      const height = 1 + (seed % 11);
      seed = next(seed);
      const round = seed % 4;
      seed = next(seed);
      const kind = (seed & 1) === 0 ? "attest" : "skip";
      seed = next(seed);
      const value = seed.toString(16).padStart(64, "0");
      const slot = `${height}:${round}`;
      const choice = `${kind}:${value}`;
      const expected = model.get(slot);
      const operation = kind === "attest"
        ? () => journal.reserveAttestation(height, round, value)
        : () => journal.reserveSkip(height, round, value);
      if (expected === undefined || expected === choice) {
        await operation();
        model.set(slot, choice);
      } else {
        await assert.rejects(operation, /Conflicting validator action/);
      }
      if (step % 23 === 22) {
        journal.close();
        journal = await SigningJournal.open(directory);
      }
    }

    // Reopen once more and prove every persisted first choice remains
    // idempotent while an alternate choice is rejected.
    journal.close();
    journal = await SigningJournal.open(directory);
    for (const [slot, choice] of model) {
      const [heightText, roundText] = slot.split(":");
      const separator = choice.indexOf(":");
      const kind = choice.slice(0, separator);
      const value = choice.slice(separator + 1);
      const height = Number(heightText);
      const round = Number(roundText);
      if (kind === "attest") await journal.reserveAttestation(height, round, value);
      else await journal.reserveSkip(height, round, value);
      const conflicting = value === "f".repeat(64) ? "e".repeat(64) : "f".repeat(64);
      await assert.rejects(
        () => kind === "attest"
          ? journal.reserveAttestation(height, round, conflicting)
          : journal.reserveSkip(height, round, conflicting),
        /Conflicting validator action/
      );
    }
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

function popcount(value: number): number {
  let count = 0;
  for (let bits = value >>> 0; bits; bits >>>= 1) count += bits & 1;
  return count;
}

function next(value: number): number {
  return ((value * 1664525) + 1013904223) >>> 0;
}
