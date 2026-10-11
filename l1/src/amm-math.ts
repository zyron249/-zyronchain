export const AMM_BASIS_POINTS = 10_000n;
export const DEFAULT_SWAP_FEE_BPS = 30n; // 0.30%
export const MAX_SWAP_FEE_BPS = 1_000n; // hard safety ceiling: 10%

export interface ExactInputQuote {
  amountIn: bigint;
  amountOut: bigint;
  feeBps: bigint;
  reserveInBefore: bigint;
  reserveOutBefore: bigint;
  reserveInAfter: bigint;
  reserveOutAfter: bigint;
  kBefore: bigint;
  kAfter: bigint;
}

/**
 * Integer-only constant-product quote compatible with the usual x*y=k exact-in
 * construction. There is no Number conversion anywhere in reserve math.
 */
export function quoteExactInput(
  reserveIn: bigint,
  reserveOut: bigint,
  amountIn: bigint,
  feeBps: bigint = DEFAULT_SWAP_FEE_BPS
): ExactInputQuote {
  assertPositive(reserveIn, "reserveIn");
  assertPositive(reserveOut, "reserveOut");
  assertPositive(amountIn, "amountIn");
  assertFee(feeBps);

  const feeMultiplier = AMM_BASIS_POINTS - feeBps;
  const amountInWithFee = amountIn * feeMultiplier;
  const numerator = amountInWithFee * reserveOut;
  const denominator = (reserveIn * AMM_BASIS_POINTS) + amountInWithFee;
  if (denominator <= 0n) throw new Error("Invalid AMM denominator");

  const amountOut = numerator / denominator;
  if (amountOut <= 0n) throw new Error("Swap output rounds to zero");
  if (amountOut >= reserveOut) throw new Error("Swap would exhaust output reserve");

  const reserveInAfter = reserveIn + amountIn;
  const reserveOutAfter = reserveOut - amountOut;
  const kBefore = reserveIn * reserveOut;
  const kAfter = reserveInAfter * reserveOutAfter;
  if (kAfter < kBefore) throw new Error("Constant-product invariant decreased");

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

export function minimumAmountOut(quotedOut: bigint, slippageBps: bigint): bigint {
  assertPositive(quotedOut, "quotedOut");
  if (slippageBps < 0n || slippageBps >= AMM_BASIS_POINTS) {
    throw new Error("Invalid slippage tolerance");
  }
  return (quotedOut * (AMM_BASIS_POINTS - slippageBps)) / AMM_BASIS_POINTS;
}

export function spotPriceRatio(reserveBase: bigint, reserveQuote: bigint): {
  quoteNumerator: bigint;
  baseDenominator: bigint;
} {
  assertPositive(reserveBase, "reserveBase");
  assertPositive(reserveQuote, "reserveQuote");
  return { quoteNumerator: reserveQuote, baseDenominator: reserveBase };
}

function assertPositive(value: bigint, name: string): void {
  if (typeof value !== "bigint" || value <= 0n) throw new Error(`Invalid ${name}`);
}

function assertFee(feeBps: bigint): void {
  if (typeof feeBps !== "bigint" || feeBps < 0n || feeBps > MAX_SWAP_FEE_BPS) {
    throw new Error("Invalid AMM fee");
  }
}
