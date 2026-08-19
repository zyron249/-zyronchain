# RPC trusted-proxy rate-limit identity

Standalone ZyronChain RPC rate limiting must distinguish public clients even when the node is behind a trusted HTTPS reverse proxy.

## Policy

- Direct connections are bucketed only by the transport peer IP. `X-Forwarded-For` is ignored when no trusted proxy list is configured, so a direct client cannot choose its own rate-limit identity.
- When `trustedProxyAddresses` is configured, forwarded client identity is considered only after the transport peer itself matches that trusted set and the existing HTTPS-proxy admission check succeeds.
- At most 16 trusted RPC proxy addresses may be configured. The node rejects larger configurations during RPC server startup rather than carrying unbounded proxy-membership state into request processing.
- The normalized trusted-proxy set is built once when the RPC server starts and reused for request admission; the production request path does not rebuild the set for every request.
- `X-Forwarded-For` is parsed strictly as IP addresses. At most 16 forwarding hops are accepted. The hop count is bounded before the chain is split into an array; over-bound chains fail closed to the shared `proxy:<transport-ip>` bucket.
- Within the bound, the chain is walked from right to left, dropping trusted proxy hops; the first non-trusted IP becomes the client rate-limit identity.
- Missing, malformed, array-valued, empty, over-bound, or fully trusted forwarded chains fail closed to a shared `proxy:<transport-ip>` bucket rather than trusting attacker-controlled text.
- IPv4-mapped IPv6 addresses are normalized before comparison and bucketing.
- The bounded RPC identity limiter from issue #288 remains independent: unseen identities beyond its tracked-identity cap still share the fail-closed overflow quota rather than evicting live client state.

## Threat addressed

The trusted-proxy path executes before the fixed-window limiter can apply. Without explicit configuration and forwarding-hop bounds, a large operator configuration or a hostile client behind a trusted proxy could force avoidable proxy-set allocation and long forwarding-chain walks on every request. The cardinality bounds keep this pre-admission work deterministic while preserving the existing spoof-resistant right-to-left identity semantics.

## Deployment requirement

A production reverse proxy must overwrite or append `X-Forwarded-For` correctly and must itself be listed explicitly in `trustedProxyAddresses`. Operators must not add untrusted intermediary addresses to the trusted set. The 16-proxy and 16-hop limits are application safety bounds, not topology recommendations; deployments should use the smallest trusted set and forwarding chain practical.

This is RPC pre-admission/DoS hardening only. Public-testnet or mainnet readiness still requires real Internet abuse testing of the complete proxy and node deployment; these unit tests do not substitute for that evidence.
