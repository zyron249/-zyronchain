import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SWAP_FEE_BPS, minimumAmountOut, quoteExactInput } from "../src/amm-math.js";
test("constant-product exact-input quote preserves reserves and never decreases k", () => {
    const quote = quoteExactInput(2000000000000000n, 1000000000000n, 1000000000000n);
    assert.equal(quote.feeBps, DEFAULT_SWAP_FEE_BPS);
    assert.ok(quote.amountOut > 0n);
    assert.ok(quote.amountOut < quote.reserveOutBefore);
    assert.equal(quote.reserveInAfter, quote.reserveInBefore + quote.amountIn);
    assert.equal(quote.reserveOutAfter, quote.reserveOutBefore - quote.amountOut);
    assert.ok(quote.kAfter >= quote.kBefore);
});
test("AMM invariant holds over a deterministic adversarial reserve grid", () => {
    const reserves = [
        1000n,
        10000n,
        1000000n,
        100000000n,
        5000000000000000n,
        50000000000000000n
    ];
    const inputs = [1n, 2n, 10n, 999n, 10000n, 1000000n, 1000000000n];
    for (const reserveIn of reserves) {
        for (const reserveOut of reserves) {
            for (const amountIn of inputs) {
                try {
                    const quote = quoteExactInput(reserveIn, reserveOut, amountIn);
                    assert.ok(quote.amountOut > 0n);
                    assert.ok(quote.amountOut < reserveOut);
                    assert.ok(quote.kAfter >= quote.kBefore);
                }
                catch (error) {
                    assert.match(String(error), /rounds to zero|Invalid|exhaust/);
                }
            }
        }
    }
});
test("larger exact input cannot produce a smaller output for the same reserves", () => {
    const reserveIn = 20000000000000000n;
    const reserveOut = 1000000000000000n;
    let previous = 0n;
    for (let amount = 1000000n; amount <= 100000000n; amount += 1000000n) {
        const out = quoteExactInput(reserveIn, reserveOut, amount).amountOut;
        assert.ok(out >= previous);
        previous = out;
    }
});
test("slippage protection is integer-only and bounded", () => {
    assert.equal(minimumAmountOut(1000000n, 50n), 995000n);
    assert.equal(minimumAmountOut(1000000n, 0n), 1000000n);
    assert.throws(() => minimumAmountOut(1000000n, 10000n), /Invalid slippage/);
});
test("AMM rejects zero/negative reserves and excessive fees", () => {
    assert.throws(() => quoteExactInput(0n, 1n, 1n), /reserveIn/);
    assert.throws(() => quoteExactInput(1n, 0n, 1n), /reserveOut/);
    assert.throws(() => quoteExactInput(1n, 1n, 0n), /amountIn/);
    assert.throws(() => quoteExactInput(1000n, 1000n, 1n, 1001n), /Invalid AMM fee/);
});
