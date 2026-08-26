# Native Discovery Frame Custody

Native discovery uses directional frame ceilings: requests are bounded to 2 KiB because they contain only the exact `{version, identity}` record, while responses retain the existing 20 KiB ceiling required for up to 32 bounded candidate addresses. This prevents tiny authenticated requests from reserving response-sized outbound capacity and prevents the inbound server from accepting response-sized request frames before request validation. The 32-candidate response cap, 512-byte candidate bound, authenticated Noise transport, chain-identity validation, per-peer rate limiting, and the 5-second stream timeout are unchanged.

The discovery request and response paths use retained P2P frame ownership while validating decoded peer-controlled data. Encoded and decoded frame-budget reservations stay held through exact record-shape checks, chain identity validation, candidate string bounds, pinned multiaddr parsing, and duplicate PeerId rejection. The lease is released immediately after validation/normalization finishes; returned `Multiaddr[]` values are not charged to the frame budget after they have been reduced to the bounded canonical discovery result.

The request ceiling is applied to client request writes and server request reads. The response ceiling is applied to server response writes and client response reads. This keeps the global frame-budget reservation proportional to each message class without changing discovery trust: returned addresses remain untrusted hints and must still be dialed and chain-authenticated before admission.

This is P2P availability/resource-accounting hardening only. It is not Sybil resistance, independent-operator evidence, public-testnet readiness, mainnet readiness, or public-mining activation evidence.
