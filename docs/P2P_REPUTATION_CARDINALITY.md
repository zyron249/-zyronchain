# Native P2P reputation cardinality hardening

The native libp2p peer-reputation store is bounded to 256 persisted PeerIds. That bound is a memory/disk safety control, not evidence of Sybil resistance or public-testnet readiness.

Previously, inserting a new identity after saturation evicted the oldest tracked identity. Because PeerIds are inexpensive to generate, hostile identity rotation could displace an actively penalized peer and later reuse that identity without its backoff/protocol-ban state.

The store now fails closed at saturation. Active penalties are never evicted merely to admit an unseen identity. An unseen PeerId is unavailable while all 256 tracked entries remain under active backoff/ban. Capacity is reclaimed only from entries whose penalty has expired, using deterministic oldest-activity ordering with PeerId tie-breaking. Successful/unpenalized entries are therefore reclaimable, while live penalties remain pinned until their natural expiry.

This control complements the existing bounded peer pool, discovery-source caps, per-topology limits, connection/dial limits and authenticated Noise/chain-identity checks. It does not make permissioned validator networking permissionless, does not prove eclipse/Sybil resistance on the public Internet, and does not satisfy the external evidence gates in issues #249, #260 or #261.

Regression coverage must prove that rotating unseen PeerIds cannot displace active bans, persisted entry count remains bounded, and a slot becomes usable again after penalty expiry.
