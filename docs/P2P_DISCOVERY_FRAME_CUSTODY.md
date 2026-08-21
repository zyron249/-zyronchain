# Native Discovery Frame Custody

Native discovery frames remain bounded by the existing 20 KiB frame limit, 32-candidate response cap, authenticated Noise transport, chain-identity validation, per-peer rate limiting, and the 5-second stream timeout.

The discovery request and response paths now use retained P2P frame ownership while validating decoded peer-controlled data. Encoded and decoded frame-budget reservations stay held through exact record-shape checks, chain identity validation, candidate string bounds, pinned multiaddr parsing, and duplicate PeerId rejection. The lease is released immediately after validation/normalization finishes; returned `Multiaddr[]` values are not charged to the frame budget after they have been reduced to the bounded canonical discovery result.

This closes an accounting gap where `readP2PFrame()` released the global inbound frame reservation before discovery validation consumed the decoded object. It does not change discovery trust: returned addresses remain untrusted hints and must still be dialed and chain-authenticated before admission.

This is P2P availability/resource-accounting hardening only. It is not Sybil resistance, independent-operator evidence, public-testnet readiness, mainnet readiness, or public-mining activation evidence.
