# Native P2P frame allocation boundary

Status: **pre-mainnet security hardening evidence**. This document does not authorize public-testnet or mainnet activation.

Native ZyronChain protocols use a 4-byte length-prefixed JSON frame. The decoder enforces four separate memory boundaries:

- the declared body length must be within the protocol-specific `maxBytes` limit;
- the encoded body must fit the process-wide inbound `P2PFrameByteBudget` before the body buffer is allocated;
- immediately before JSON decoding, a second frame-sized allowance must also fit the same process-wide budget to account for the decoded string/object graph; encoded and decoded allowances stay reserved together until caller processing releases the retained frame;
- an individual libp2p transport chunk is rejected before parsing if its byte length exceeds the complete `4 + maxBytes` frame envelope.

The transport-chunk rule is intentionally checked on the transport-owned `Uint8Array` before any full-chunk `Buffer` copy. Normal parsing uses zero-copy views and copies only the bounded header/body bytes into their already-limited destinations. The second retained-frame allowance prevents multiple authenticated peers from synchronizing large valid JSON frames whose encoded bodies fit the byte budget while their decoded object graphs multiply heap pressure outside it.

Trailing bytes, truncated frames, invalid JSON, timeouts, encoded-body exhaustion and decoded-frame-budget exhaustion remain hard failures. Every failure path releases any reservations already acquired, and the retained-frame release boundary is idempotent. Operators should continue monitoring the `p2pFrames.inbound` and `p2pFrames.outbound` metrics described in `L1_OPERATIONS_RUNBOOK.md`; this hardening is an implementation boundary, not evidence of Internet-scale adversarial readiness.
