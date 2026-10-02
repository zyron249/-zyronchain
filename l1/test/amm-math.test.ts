import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SWAP_FEE_BPS,
  minimumAmountOut,
  quoteExactInput
} from "../src/amm-math.js";

test("constant-product exact-input quote preserves reserves and never decreases k", () => {
  const quote = quoteExactInput(20_000_000_00000000n, 1_000_000_000000n, 10_000_00000000n);
  assert.equal(quote.feeBps, DEFAULT_SWAP_FEE_BPS);
  assert.ok(quote.amountOut > 0n);
  assert.ok(quote.amountOut < quote.reserveOutBefore);
  assert.equal(quote.reserveInAfter, quote.reserveInBefore + quote.amountIn);
  assert.equal(quote.reserveOutAfter, quote.reserveOutBefore - quote.amountOut);
  assert.ok(quote.kAfter >= quote.kBefore);
});

test("AMM invariant holds over a deterministic adversarial reserve grid", () => {
  const reserves = [
    1_000n,
    10_000n,
    1_000_000n,
    100_000_000n,
    5_000_000_000_000_000n,
    50_000_000_000_000_000n
  ];
  const inputs = [1n, 2n, 10n, 999n, 10_000n, 1_000_000n, 1_000_000_000n];

  for (const reserveIn of reserves) {
    for (const reserveOut of reserves) {
      for (const amountIn of inputs) {
        try {
          const quote = quoteExactInput(reserveIn, reserveOut, amountIn);
          assert.ok(quote.amountOut > 0n);
          assert.ok(quote.amountOut < reserveOut);
          assert.ok(quote.kAfter >= quote.kBefore);
        } catch (error) {
          assert.match(String(error), /rounds to zero|Invalid|exhaust/);
        }
      }
    }
  }
});

test("larger exact input cannot produce a smaller output for the same reserves", () => {
  const reserveIn = 20_000_000_000_000_000n;
  const reserveOut = 1_000_000_000_000_000n;
  let previous = 0n;
  for (let amount = 1_000_000n; amount <= 100_000_000n; amount += 1_000_000n) {
    const out = quoteExactInput(reserveIn, reserveOut, amount).amountOut;
    assert.ok(out >= previous);
    previous = out;
  }
});

test("slippage protection is integer-only and bounded", () => {
  assert.equal(minimumAmountOut(1_000_000n, 50n), 995_000n);
  assert.equal(minimumAmountOut(1_000_000n, 0n), 1_000_000n);
  assert.throws(() => minimumAmountOut(1_000_000n, 10_000n), /Invalid slippage/);
});

test("AMM rejects zero/negative reserves and excessive fees", () => {
  assert.throws(() => quoteExactInput(0n, 1n, 1n), /reserveIn/);
  assert.throws(() => quoteExactInput(1n, 0n, 1n), /reserveOut/);
  assert.throws(() => quoteExactInput(1n, 1n, 0n), /amountIn/);
  assert.throws(() => quoteExactInput(1_000n, 1_000n, 1n, 1_001n), /Invalid AMM fee/);
});
