# RPC client response security

The published ZyronChain CLI treats every RPC response as untrusted input, including responses from a configured endpoint.

`readBoundedResponseText()` keeps the caller-provided wire-byte limit as the hard allocation ceiling. When `Content-Length` is present it must be a canonical non-negative decimal integer, must not exceed the caller limit, and the observed stream length must match it exactly. The reader writes transport chunks directly into one bounded destination buffer rather than retaining all chunks and then allocating a second full contiguous response copy. Oversized streamed input is rejected and the response body is cancelled on a best-effort basis.

`readBoundedJson()` additionally rejects JSON deeper than 64 array/object levels or containing more than 250,000 structural punctuation tokens before `JSON.parse()` is invoked. Punctuation and escaped quotes inside JSON strings do not consume that structural quota. These limits are client-side DoS controls; they do not replace route-specific schema validation, RPC API-version checks, authentication, consensus validation, or server-side request/response budgets.

This hardening does not provide public-testnet, mainnet, or public-mining readiness evidence and does not change any activation gate.
