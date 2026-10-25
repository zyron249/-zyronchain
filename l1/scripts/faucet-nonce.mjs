// Faucet nonce tracking (Red Team Session 1, INFO #9). The local cache only
// covers drips the node has not mined yet; chain state always wins when it
// goes backwards (snapshot restore / cold-start replacement), when a drip is
// rejected, when the cache is stale, or when the cache is further ahead than
// the mempool window could hold.
const MEMPOOL_WINDOW = 64;

export function createFaucetNonceTracker({ staleMs = 180_000 } = {}) {
  let last = 0;
  let lastAt = 0;
  let chainSeen = -1;
  return {
    next(chainNonce, nowMs) {
      if (!Number.isSafeInteger(chainNonce) || chainNonce < 0) throw new Error(`faucet nonce lookup returned an invalid nonce: ${chainNonce}`);
      if (chainNonce < chainSeen || nowMs - lastAt > staleMs || last > chainNonce + MEMPOOL_WINDOW) last = 0;
      chainSeen = chainNonce;
      return Math.max(chainNonce, last) + 1;
    },
    accepted(nonce, nowMs) { last = nonce; lastAt = nowMs; },
    rejected() { last = 0; lastAt = 0; }
  };
}
