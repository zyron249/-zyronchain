# Native P2P frame allocation boundary

Status: **pre-mainnet security hardening evidence**. This document does not authorize public-testnet or mainnet activation.

Native ZyronChain protocols use a 4-byte length-prefixed JSON frame. The decoder enforces three separate memory boundaries:

- the declared body length must be within the protocol-specific `maxBytes` limit;
- retained decoded bodies must fit the process-wide inbound `P2PFrameByteBudget` before the body buffer is allocated;
- an individual libp2p transport chunk is rejected before parsing if its byte length exceeds the complete `4 + maxBytes` frame envelope.

The transport-chunk rule is intentionally checked on the transport-owned `Uint8Array` before any full-chunk `Buffer` copy. Normal parsing uses zero-copy views and copies only the bounded header/body bytes into their already-limited destinations. This prevents a peer from using a single oversized muxer chunk to force a transient user-space allocation before the declared frame length or aggregate byte budget can fail closed.

Trailing bytes, truncated frames, invalid JSON, timeouts and aggregate byte-budget exhaustion remain hard failures. Operators should continue monitoring the `p2pFrames.inbound` and `p2pFrames.outbound` metrics described in `L1_OPERATIONS_RUNBOOK.md`; this hardening is an implementation boundary, not evidence of Internet-scale adversarial readiness.
