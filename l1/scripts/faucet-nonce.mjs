// Faucet nonce tracking (Red Team Session 1, INFO #9). The local cache only
// covers drips the node has not mined yet; chain state always wins when it
// goes backwards (snapshot restore / cold-start replacement), when the cache is
// stale, or when the cache is further ahead than the mempool window could hold.
//
// Hardening batch: a non-2xx from POST /tx no longer blindly resets the cache
// to the chain nonce (which reused nonces of drips that are still pending, so
// every later drip hit "Conflicting sender nonce" until they were mined) and
// never blindly advances it (which could leave a gap if the drip was not
// admitted). It resyncs instead:
// - the error proves the nonce is already taken (nonce conflict, already in
//   the mempool, already used on chain): the nonce counts as used, advance;
// - otherwise (5xx, timeout, or a definitive refusal such as a fee error): the
//   drip may or may not have been admitted, so the next drip reuses the same
//   nonce on top of the still-pending prefix. If it had been admitted, that
//   retry gets the conflict error above and the tracker advances then.
// In both cases the next() call still compares against fresh chain state.
const MEMPOOL_WINDOW = 64;
const NONCE_TAKEN = /Conflicting sender nonce|already in mempool|nonce already used/i;

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
    /**
     * `nonce` is the nonce of the rejected drip; `result` is the node's
     * `{ status, error }`. lastAt is kept, so the stale timer still applies.
     */
    rejected(nonce, result = {}) {
      if (!Number.isSafeInteger(nonce) || nonce < 1) { last = 0; lastAt = 0; return; }
      last = NONCE_TAKEN.test(String(result.error ?? "")) ? nonce : nonce - 1;
    }
  };
}
