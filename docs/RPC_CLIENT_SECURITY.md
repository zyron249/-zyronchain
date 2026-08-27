# RPC client response security

The published ZyronChain CLI treats every RPC response as untrusted input, including responses from a configured endpoint.

`readBoundedResponseText()` keeps the caller-provided wire-byte limit as the hard allocation ceiling. When `Content-Length` is present it must be a canonical non-negative decimal integer, must not exceed the caller limit, and the observed stream length must match it exactly. A trustworthy declared length is allocated exactly. When `Content-Length` is absent, the reader starts with at most a 4 KiB destination and grows deterministically only as observed bytes require, never beyond the caller's `maxBytes` ceiling. Growth keeps a single current destination rather than retaining every transport chunk; a resize may briefly retain the previous and replacement bounded buffers while bytes are copied. Oversized streamed input is rejected and the response body is cancelled on a best-effort basis.

`readBoundedJson()` additionally rejects JSON deeper than 64 array/object levels or containing more than 250,000 structural punctuation tokens before `JSON.parse()` is invoked. Punctuation and escaped quotes inside JSON strings do not consume that structural quota. These limits are client-side DoS controls; they do not replace route-specific schema validation, RPC API-version checks, authentication, consensus validation, or server-side request/response budgets.

This hardening does not provide public-testnet, mainnet, or public-mining readiness evidence and does not change any activation gate.