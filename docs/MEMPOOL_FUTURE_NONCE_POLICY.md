# Mempool policy: future-nonce (parked) transactions

Red Team Session 1, MEDIUM 1. This is node mempool policy only. Block validity,
consensus rules, genesis and activation flags are unchanged.

## Background

The mempool accepts sender nonces from `confirmed + 1` to `confirmed + 64`
(`MAX_MEMPOOL_PENDING_PER_SENDER`). A transaction whose nonce leaves a gap
above the confirmed nonce cannot be included until the gap is filled. Before
this policy such "parked" transactions had no separate per-address bound
(about 63 per funded address) and no expiry.

## Policy

A pending transaction is **ready** when every nonce from `confirmed + 1` up to
its own is pending. Otherwise it is **parked**.

| Setting | Default | CLI flag | Environment variable |
|---|---|---|---|
| Parked transactions per address | 16 | `--mempool-max-future-per-sender <n>` (1 to 64) | `ZYRON_MEMPOOL_MAX_FUTURE_PER_SENDER` |
| Parked transaction TTL | 600000 ms (10 min) | `--mempool-parked-ttl-ms <ms>` (1 to 86400000, i.e. at most 24 h) | `ZYRON_MEMPOOL_PARKED_TTL_MS` |

The CLI flag takes precedence over the environment variable. A TTL outside
1 to 86400000 ms fails closed at startup with
`Mempool parked transaction TTL must be an integer from 1 to 86400000 ms`.
The 24 hour bound keeps a misconfigured node from holding parked
transactions practically forever.

- **Replacement keeps the admission time:** a same-nonce fee-bump replacement
  inherits the original admission time of that sender and nonce, so repeated
  replacements cannot extend the parked TTL.

- **Cap:** a new transaction that would be parked is rejected when the sender
  already has the maximum number of parked transactions, with
  `Too many future-nonce transactions for sender (limit N); submit nonce K first`.
  A same-nonce replacement, a transaction that fills the gap and ready
  transactions are not counted. Other addresses are unaffected.
- **TTL:** a parked transaction admitted more than the TTL ago is evicted. The
  sweep runs after every finalized block and on admission (at most once per
  second). A parked transaction whose gap is filled before the TTL becomes
  ready and is not evicted by this policy. Ready transactions never expire
  under this policy.
- **Parked response (Red Team S1 retest LOW-1):** `POST /tx` answers
  `{ "txid", "status": "pending" }` for a ready transaction and
  `{ "txid", "status": "parked", "waitingForNonce": K }` for a parked one,
  where `K` is the first missing nonce. The gateways keep `accepted: true` and
  `txid` and say "Parked, waiting for nonce K" instead of "Included in a coming
  block (about 30 seconds)". `status` is a new field; clients that ignore it
  are unaffected.
- **Seen-expired cache (Red Team S1 retest LOW-2):** a parked transaction
  evicted by the TTL is remembered by txid for 60 minutes
  (`SEEN_EXPIRED_CACHE_TTL_MS`), at most 10,000 entries
  (`SEEN_EXPIRED_CACHE_MAX_ENTRIES`, oldest dropped first). While remembered,
  resubmitting the same signed transaction is refused with
  `Transaction expired from this node's mempool while parked (nonce N); it is refused until nonce K is submitted first`
  as long as it would be parked again. Once the gap closes (nonce `K` is
  pending or confirmed) the same transaction is admitted normally.

  Why a cache and not only "the gap must have closed": the gap check alone
  needs no new state, but it would refuse the transaction forever if the
  sender never fills the gap, with no record of why. Combining both keeps the
  cache bounded and short-lived and never refuses a transaction that could be
  included now. A newly signed transaction for the same nonce has a different
  txid and is admitted (subject to the cap), which costs the sender a fresh
  signature, so anyone who only holds the signed bytes cannot keep a parked
  transaction alive.

## Limits

- The TTL counts from admission to this node. After the seen-expired cache
  forgets a transaction (60 minutes, or when 10,000 newer evictions push it
  out), a resubmission of it is admitted again with a new TTL. The cache is
  per node and is lost on restart.
- Parking is still possible up to the cap per address; the cap bounds, but
  does not remove, the cost of zero-fee parked transactions while no fee
  policy is active (see Red Team MEDIUM 2, handled separately).
- The policy is per node and is not enforced on other nodes or in blocks.
