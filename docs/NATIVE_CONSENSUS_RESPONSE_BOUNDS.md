# Native Consensus Response Byte Bounds

Native consensus requests retain the existing 2.5 MiB frame ceiling because block-bearing requests can legitimately be large. Peer responses have fixed accepted shapes and therefore use tighter response-kind ceilings before JSON materialization and during server-side serialization:

- attestation: 8 KiB
- round-skip vote: 16 KiB
- block acknowledgement: 4 KiB
- transaction acknowledgement: 4 KiB

`NativeConsensusPeerClient` selects the response ceiling from the request kind before `readP2PFrameRetained()` decodes the response. `registerP2PConsensusProtocol()` now uses that same response-kind ceiling when calling `writeP2PFrame()`. Because the frame writer reserves its configured ceiling before serialization, small fixed-shape responses no longer consume the 2.5 MiB request allowance twice from the shared outbound frame budget. Oversized responses fail closed instead of expanding the response budget.

The 2.5 MiB request ceiling remains unchanged for block-bearing requests. This hardening does not change Noise authentication, chain identity validation, timeouts, response exact-shape validation, signature checks, validator-set checks, quorum/finality semantics, gossip behavior, or activation policy. It is availability/resource-bound hardening only and is not evidence that public testnet, mainnet, or public mining is ready.
