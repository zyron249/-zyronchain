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

## Limits

- The TTL counts from admission to this node. A transaction relayed again by a
  peer after eviction can be admitted again (with a new TTL).
- Parking is still possible up to the cap per address; the cap bounds, but
  does not remove, the cost of zero-fee parked transactions while no fee
  policy is active (see Red Team MEDIUM 2, handled separately).
- Clients still receive "accepted" for a parked transaction; the response has
  no queued/parked signal yet.
- The policy is per node and is not enforced on other nodes or in blocks.
