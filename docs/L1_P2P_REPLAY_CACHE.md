# L1 P2P replay-cache boundary

Authenticated peer requests are replay-protected with a bounded in-memory nonce cache. The cache remains fail-closed: live nonce entries are never evicted merely to admit new requests.

Two independent capacity limits apply:

- a global ceiling of 10,000 unexpired authenticated peer nonces;
- a per-authenticated-identity ceiling of 2,500 unexpired nonces, or the configured lower test/rehearsal limit.

The per-identity ceiling prevents one compromised or malicious trusted peer from consuming the entire global replay cache and denying otherwise valid requests from every other trusted peer. Both preflight and final verification apply the same quota only after header identity checks and signature verification. Expired entries are swept on the existing amortized schedule and their per-identity counts are decremented at the same time; unexpired entries are never evicted to reset quota.

This is a P2P denial-of-service containment measure only. It does not change chain identity binding, request signatures, timestamp skew, replay semantics, consensus/finality rules, validator membership, mining rewards, or any public-testnet/mainnet activation gate.
