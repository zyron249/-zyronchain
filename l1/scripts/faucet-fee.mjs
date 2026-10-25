// Faucet transfer fee (#1137 / #1140 follow-ups), shared by the open-testnet
// gateway (open-testnet.mjs) and the wallet-testnet gateway
// (public-testnet-rpc.mjs). The mempool fee floor is node policy set by
// ZYRON_MEMPOOL_MIN_FEE_ATOMS and reported on GET /status; it stays env-only
// until fee-v1 activates at consensus.
// The faucet and the smoke transfer pay max(own env floor, the target node's
// GET /status minTransferFeeAtoms), read fresh for every drip. If the node's
// floor cannot be read or is invalid, the drip FAILS LOUDLY (error-level log
// and a clear 503 to the caller) instead of sending a transfer that would be
// rejected.
export class FaucetFeeFloorError extends Error {
  constructor(detail) { super(`faucet cannot meet the node's minimum transfer fee: ${detail}`); this.name = "FaucetFeeFloorError"; this.code = "fee-floor"; }
}
// Upper bound on the fee the faucet (and the smoke transfer) will pay per
// transfer: 1,000,000 atoms = 0.01 test ZYN, 1,000x the open-testnet floor of
// 1,000 atoms and 1/10,000 of a 100 ZYN drip. A node /status reporting a
// higher floor (or fixed fee) is treated as misconfigured: the drip fails with
// fee-floor (503, error-level log) and no transfer is sent.
export const MAX_FAUCET_FEE_ATOMS = 1_000_000;
// When /status reports fixedTransferFeeAtoms (fee-v1 is active), the faucet
// pays EXACTLY that fee and the floor logic is not used.
export function faucetTransferFeeAtoms(envFloorAtoms, statusResponse) {
  if (!statusResponse || statusResponse.status !== 200 || !statusResponse.body || typeof statusResponse.body !== "object") {
    throw new FaucetFeeFloorError(`node /status unavailable (status ${statusResponse?.status ?? "none"})`);
  }
  const fixed = statusResponse.body.fixedTransferFeeAtoms;
  if (fixed !== undefined && fixed !== null) {
    if (typeof fixed !== "number" || !Number.isSafeInteger(fixed) || fixed < 0) throw new FaucetFeeFloorError("node /status has an invalid fixedTransferFeeAtoms");
    if (fixed > MAX_FAUCET_FEE_ATOMS) throw new FaucetFeeFloorError(`node fixed fee of ${fixed} atoms exceeds MAX_FAUCET_FEE_ATOMS (${MAX_FAUCET_FEE_ATOMS})`);
    return fixed;
  }
  const floor = statusResponse.body.minTransferFeeAtoms;
  if (typeof floor !== "number" || !Number.isSafeInteger(floor) || floor < 0) throw new FaucetFeeFloorError("node /status has no valid minTransferFeeAtoms");
  const fee = Math.max(envFloorAtoms, floor);
  if (!Number.isSafeInteger(fee) || fee < floor) throw new FaucetFeeFloorError(`fee ${fee} atoms is below the node floor of ${floor} atoms`);
  if (fee > MAX_FAUCET_FEE_ATOMS) throw new FaucetFeeFloorError(`fee floor of ${fee} atoms exceeds MAX_FAUCET_FEE_ATOMS (${MAX_FAUCET_FEE_ATOMS})`);
  return fee;
}
