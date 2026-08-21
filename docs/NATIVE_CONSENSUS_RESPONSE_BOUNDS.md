# Native Consensus Response Byte Bounds

Native consensus requests retain the existing 2.5 MiB frame ceiling because block-bearing requests can legitimately be large. Peer responses have fixed accepted shapes and therefore use tighter response-kind ceilings before JSON materialization:

- attestation: 8 KiB
- round-skip vote: 16 KiB
- block acknowledgement: 4 KiB
- transaction acknowledgement: 4 KiB

`NativeConsensusPeerClient` selects the response ceiling from the request kind before `readP2PFrameRetained()` decodes the response. Oversized authenticated Noise-peer responses therefore fail closed at the frame boundary rather than consuming the block-sized response allowance.

This hardening does not change Noise authentication, chain identity validation, timeouts, response exact-shape validation, signature checks, validator-set checks, quorum/finality semantics, gossip behavior, or activation policy. It is availability/resource-bound hardening only and is not evidence that public testnet, mainnet, or public mining is ready.
