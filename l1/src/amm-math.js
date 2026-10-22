export const AMM_BASIS_POINTS = 10000n;
export const DEFAULT_SWAP_FEE_BPS = 30n; // 0.30%
export const MAX_SWAP_FEE_BPS = 1000n; // hard safety ceiling: 10%
/**
 * Integer-only constant-product quote compatible with the usual x*y=k exact-in
 * construction. There is no Number conversion anywhere in reserve math.
 */
export function quoteExactInput(reserveIn, reserveOut, amountIn, feeBps = DEFAULT_SWAP_FEE_BPS) {
    assertPositive(reserveIn, "reserveIn");
    assertPositive(reserveOut, "reserveOut");
    assertPositive(amountIn, "amountIn");
    assertFee(feeBps);
    const feeMultiplier = AMM_BASIS_POINTS - feeBps;
    const amountInWithFee = amountIn * feeMultiplier;
    const numerator = amountInWithFee * reserveOut;
    const denominator = (reserveIn * AMM_BASIS_POINTS) + amountInWithFee;
    if (denominator <= 0n)
        throw new Error("Invalid AMM denominator");
    const amountOut = numerator / denominator;
    if (amountOut <= 0n)
        throw new Error("Swap output rounds to zero");
    if (amountOut >= reserveOut)
        throw new Error("Swap would exhaust output reserve");
    const reserveInAfter = reserveIn + amountIn;
    const reserveOutAfter = reserveOut - amountOut;
    const kBefore = reserveIn * reserveOut;
    const kAfter = reserveInAfter * reserveOutAfter;
    if (kAfter < kBefore)
        throw new Error("Constant-product invariant decreased");
    return {
        amountIn,
        amountOut,
        feeBps,
        reserveInBefore: reserveIn,
        reserveOutBefore: reserveOut,
        reserveInAfter,
        reserveOutAfter,
        kBefore,
        kAfter
    };
}
export function minimumAmountOut(quotedOut, slippageBps) {
    assertPositive(quotedOut, "quotedOut");
    if (slippageBps < 0n || slippageBps >= AMM_BASIS_POINTS) {
        throw new Error("Invalid slippage tolerance");
    }
    return (quotedOut * (AMM_BASIS_POINTS - slippageBps)) / AMM_BASIS_POINTS;
}
export function spotPriceRatio(reserveBase, reserveQuote) {
    assertPositive(reserveBase, "reserveBase");
    assertPositive(reserveQuote, "reserveQuote");
    return { quoteNumerator: reserveQuote, baseDenominator: reserveBase };
}
function assertPositive(value, name) {
    if (typeof value !== "bigint" || value <= 0n)
        throw new Error(`Invalid ${name}`);
}
function assertFee(feeBps) {
    if (typeof feeBps !== "bigint" || feeBps < 0n || feeBps > MAX_SWAP_FEE_BPS) {
        throw new Error("Invalid AMM fee");
    }
}
