import assert from "node:assert/strict";
import test from "node:test";

import {
  BLOCKS_PER_DAY,
  FOUNDER_CLIFF_BLOCKS,
  FOUNDER_LINEAR_VESTING_BLOCKS,
  founderAvailableAtomsAtHeight,
  founderVestedAtomsAtHeight
} from "../src/founder-vesting.js";
import { FOUNDER_ALLOCATION_ATOMS } from "../src/tokenomics.js";

test("founder vesting uses deterministic block-height boundaries", () => {
  assert.equal(BLOCKS_PER_DAY, 2_880);
  assert.equal(FOUNDER_CLIFF_BLOCKS, 1_051_200);
  assert.equal(FOUNDER_LINEAR_VESTING_BLOCKS, 3_153_600);

  assert.equal(founderVestedAtomsAtHeight(0), 0);
  assert.equal(founderVestedAtomsAtHeight(FOUNDER_CLIFF_BLOCKS), 0);
  assert.equal(founderVestedAtomsAtHeight(FOUNDER_CLIFF_BLOCKS + 1) > 0, true);
  assert.equal(
    founderVestedAtomsAtHeight(FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS),
    FOUNDER_ALLOCATION_ATOMS
  );
  assert.equal(
    founderVestedAtomsAtHeight(FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS + 1_000_000),
    FOUNDER_ALLOCATION_ATOMS
  );
});

test("founder vesting is monotonic and never exceeds 5M ZYN", () => {
  let previous = 0;
  const end = FOUNDER_CLIFF_BLOCKS + FOUNDER_LINEAR_VESTING_BLOCKS;
  for (let step = 0; step <= 10_000; step += 1) {
    const height = Math.floor((end * step) / 10_000);
    const vested = founderVestedAtomsAtHeight(height);
    assert.ok(vested >= previous);
    assert.ok(vested >= 0);
    assert.ok(vested <= FOUNDER_ALLOCATION_ATOMS);
    previous = vested;
  }
  assert.equal(previous, FOUNDER_ALLOCATION_ATOMS);
});

test("available founder amount cannot exceed vested minus already claimed", () => {
  const halfway = FOUNDER_CLIFF_BLOCKS + Math.floor(FOUNDER_LINEAR_VESTING_BLOCKS / 2);
  const vested = founderVestedAtomsAtHeight(halfway);
  const claimed = Math.floor(vested / 3);
  assert.equal(founderAvailableAtomsAtHeight(halfway, claimed), vested - claimed);
  assert.equal(founderAvailableAtomsAtHeight(FOUNDER_CLIFF_BLOCKS, 0), 0);
  assert.throws(
    () => founderAvailableAtomsAtHeight(halfway, FOUNDER_ALLOCATION_ATOMS + 1),
    /exceeds allocation/
  );
});

test("vesting rejects malformed heights and unsafe atom amounts", () => {
  assert.throws(() => founderVestedAtomsAtHeight(-1), /Invalid height/);
  assert.throws(() => founderVestedAtomsAtHeight(Number.MAX_SAFE_INTEGER, 1), /cliff height overflow/);
  assert.throws(() => founderVestedAtomsAtHeight(1, 0, Number.MAX_SAFE_INTEGER + 1), /Invalid atom amount/);
});
