# Native P2P frame allocation boundary

Status: **pre-mainnet security hardening evidence**. This document does not authorize public-testnet or mainnet activation.

Native ZyronChain protocols use a 4-byte length-prefixed JSON frame. The decoder enforces five separate memory boundaries:

- the declared body length must be within the protocol-specific `maxBytes` limit;
- the encoded body must fit the process-wide inbound `P2PFrameByteBudget` before the body buffer is allocated;
- immediately before JSON decoding, a second frame-sized allowance must also fit the same process-wide budget to account for the decoded string/object graph; encoded and decoded allowances stay reserved together until caller processing releases the retained frame;
- before `JSON.parse`, the already-bounded UTF-8 bytes are scanned without creating another full copy and rejected if JSON nesting exceeds 64 levels or structural punctuation exceeds 250,000 tokens outside strings; this prevents small-on-wire but high-cardinality arrays/objects from amplifying V8 heap usage beyond the nominal decoded-frame allowance;
- an individual libp2p transport chunk is rejected before parsing if its byte length exceeds the complete `4 + maxBytes` frame envelope.

The transport-chunk rule is intentionally checked on the transport-owned `Uint8Array` before any full-chunk `Buffer` copy. Normal parsing uses zero-copy views and copies only the bounded header/body bytes into their already-limited destinations. The second retained-frame allowance limits aggregate decoded pressure, while the structural-complexity scan separately bounds object-graph amplification that encoded byte length alone cannot represent. Punctuation and escaped quotes inside JSON strings do not consume the structural-token budget.

Outbound framing uses the same fail-closed accounting principle. Before `JSON.stringify` or UTF-8 Buffer creation, the writer reserves two frame-sized allowances from the process-wide outbound budget: one for the transient serialized JS string and one for the encoded Buffer retained through backpressure and stream close. Both reservations remain held until the send boundary completes and are released on success, serialization failure, timeout, backpressure failure, or close failure. This intentionally favors bounded peak memory over maximum concurrent large responses.

Trailing bytes, truncated frames, invalid JSON, excessive JSON structural complexity, timeouts, encoded-body exhaustion, decoded-frame-budget exhaustion and outbound serialization-budget exhaustion remain hard failures. Every failure path releases any reservations already acquired, and retained-frame release boundaries are idempotent. Operators should continue monitoring the `p2pFrames.inbound` and `p2pFrames.outbound` metrics described in `L1_OPERATIONS_RUNBOOK.md`; this hardening is a heap-amplification implementation boundary, not Sybil resistance or evidence of Internet-scale adversarial/public-testnet readiness.
