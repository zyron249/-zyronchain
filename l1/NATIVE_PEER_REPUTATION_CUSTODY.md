# Native P2P Peer-Reputation Custody

The native P2P reputation snapshot is bounded local security state, not a disposable cache.

- Snapshot reads remain capped at 2 MiB before JSON materialization and pass the native reputation structural-complexity preflight.
- The canonical snapshot remains version 1 with at most 256 validated PeerIds, bounded counters, bounded penalties, and no duplicate identities.
- Identity capacity is fail-closed. Once 256 PeerIds are tracked, an unknown PeerId is unavailable and its success/failure events cannot evict or replace any tracked identity, even after a tracked penalty expires. Existing tracked peers continue to update normally.
- The no-eviction rule persists across restart because the bounded snapshot is restored without admission-side reclamation.
- Persistence remains temporary-file write + file fsync + atomic rename + directory fsync where supported.
- These controls do not weaken transport authentication, protocol-failure classification, consensus/finality, recovery, or activation gates.

This hardening prevents attacker-driven PeerId churn from erasing bounded reputation history. It is defense-in-depth and is not evidence of public-testnet, public-mining, or mainnet readiness.
