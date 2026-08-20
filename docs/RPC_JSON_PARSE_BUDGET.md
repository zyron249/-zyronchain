# RPC JSON parse memory boundary

Inbound JSON RPC requests remain capped at 2.5 MiB each and retain the existing aggregate request-body, request-concurrency, rate-limit, and consensus preauthorization boundaries.

Before `Buffer.concat` or UTF-8 decoding allocates additional parse representations, the request now reserves conservative transient capacity from the same aggregate request-body byte budget. The transient allowance covers one contiguous byte copy plus the worst-case two-byte-per-character JavaScript UTF-8 decode representation. It is released immediately after parsing or on every parse/complexity failure; the original wire-body reservation remains held through the existing request lifecycle.

The lifecycle regression verifies the two phases independently: enough aggregate headroom is provided for the temporary parse reservation, the original wire-body reservation remains visible while the route handler is deliberately held open, and that retained reservation returns to zero after handler completion. This avoids conflating transient parse headroom with the longer-lived request-body ownership boundary.

A bounded lexical scan runs over the already received bytes before `JSON.parse`. Nesting is limited to 64 levels and structural punctuation to 250,000 tokens. Punctuation inside JSON strings and escaped quotes do not count toward those limits. This bounds compact high-cardinality/deep JSON object-graph amplification before route-specific shape validation.

These controls are DoS hardening only. They do not change transaction, consensus, finality, mining, reward, governance, public-testnet, or mainnet activation semantics, and they are not evidence of public deployment readiness.
