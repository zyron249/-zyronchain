# Native consensus request bounds

Native consensus request framing is deliberately asymmetric.

The server keeps the inbound request ceiling at 2.5 MiB because the request kind is peer-controlled and cannot be trusted until after the frame has been decoded, retained under the global frame-memory lease, authenticated to the Noise peer identity, and exact-shape validated.

The client already knows the request kind before serialization, so outbound reservation is narrower where the protocol permits it:

- `attest`: 2,500,000 bytes because it carries a block proposal.
- `block`: 2,500,000 bytes because it carries a finalized block.
- `skip`: 128,000 bytes, aligned with the bounded round-skip request envelope.
- `transaction`: 64,000 bytes, aligned with the bounded transaction request envelope.

`writeP2PFrame()` reserves the supplied maximum from the global outbound byte budget before serialization. Kind-specific client ceilings therefore prevent small skip and transaction requests from consuming block-sized reservation capacity while preserving the block-bearing safety ceiling.

These request bounds do not change the existing response ceilings, Noise authentication, per-peer rate and inflight limits, exact request/response shape checks, timeout behavior, signature/quorum/finality validation, or activation gates. They are resource-bound hardening only and are not evidence of public-testnet or mainnet readiness.
