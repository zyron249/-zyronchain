# Miner RPC response security boundary

The standalone miner treats its configured RPC as untrusted input even after transport and network-identity checks.

The miner preserves the existing 64 KiB per-response limit, request timeout, RPC API-version requirement, HTTPS-or-loopback transport policy, and chain/genesis identity verification. Response bodies are streamed into one bounded destination buffer instead of retaining a full chunk list and then allocating a second full concatenated buffer.

When `Content-Length` is present it must use canonical decimal syntax, remain within the 64 KiB limit, and match the observed body length exactly. The reader may allocate exactly that declared bounded capacity. When `Content-Length` is absent, the reader starts with at most 4 KiB and grows the single destination buffer only as observed bytes require, never beyond the hard response ceiling. This avoids ceiling-sized allocation for tiny chunked responses while preserving bounded deterministic growth and fail-closed oversize handling.

Before `JSON.parse`, the bounded response bytes are scanned with the same conservative structural policy used by hardened RPC/P2P parsing: maximum nesting depth 64 and maximum structural-token count 250,000. Punctuation inside JSON strings, including escaped quotes, does not consume the structural quota. Malformed JSON remains fail closed.

These controls reduce miner-side parser and transient-memory DoS exposure. They do not authenticate an otherwise incorrect RPC response: API version, HTTPS/loopback policy, finalized network identity, chain ID, genesis hash, mining challenge/tip checks, and transaction-id checks remain separate mandatory boundaries.

This hardening is not evidence that public mining is ready. Public mining, release publication, signed immutable package, public-testnet, and mainnet activation gates remain independently fail closed until their required evidence exists.
