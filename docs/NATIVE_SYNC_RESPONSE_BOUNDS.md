# Native sync response resource bound

ZyronChain native finalized-history sync uses authenticated Noise streams, bounded per-peer rate/inflight admission, retained decoded-frame custody, and a transport-specific response frame ceiling.

The finalized block payload selected by `NodeService.blocks()` is capped at 20,000,000 bytes. Native sync responses add only the bounded P2P chain identity, node status, and JSON envelope, so the native server write and client retained read use a 21,000,000-byte frame ceiling rather than the generic 25,000,000-byte HTTP sync ceiling.

This matters because native frame serialization reserves space for both JSON and encoded representations, while retained parsing accounts for the encoded body, decoded graph, and transient UTF-8 decode representation. Keeping the native ceiling close to the actual payload envelope reduces avoidable global P2P byte-budget pressure without changing finalized-block selection or validation.

The following invariants remain unchanged:

- at most 100 finalized blocks are returned per batch;
- selected finalized block payload is capped at 20,000,000 bytes;
- native sync requires authenticated Noise and preserves per-peer rate/inflight limits;
- received frames remain retained until response validation/block acceptance completes;
- every accepted finalized block still passes the normal chain/finality validation path;
- HTTP/RPC sync semantics and the generic HTTP response ceiling are unchanged.

This is transport resource hardening only. It is not evidence that public mining, public testnet, or mainnet activation gates are satisfied.
