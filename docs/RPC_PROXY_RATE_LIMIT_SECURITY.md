# RPC trusted-proxy rate-limit identity

Standalone ZyronChain RPC rate limiting must distinguish public clients even when the node is behind a trusted HTTPS reverse proxy.

## Policy

- Direct connections are bucketed only by the transport peer IP. `X-Forwarded-For` is ignored when no trusted proxy list is configured, so a direct client cannot choose its own rate-limit identity.
- When `trustedProxyAddresses` is configured, forwarded client identity is considered only after the transport peer itself matches that trusted set and the existing HTTPS-proxy admission check succeeds.
- `X-Forwarded-For` is parsed strictly as IP addresses. The chain is walked from right to left, dropping trusted proxy hops; the first non-trusted IP becomes the client rate-limit identity.
- Missing, malformed, array-valued, empty, or fully trusted forwarded chains fail closed to a shared `proxy:<transport-ip>` bucket rather than trusting attacker-controlled text.
- IPv4-mapped IPv6 addresses are normalized before comparison and bucketing.

## Threat addressed

Before this hardening, the fixed-window RPC limiter always used `request.socket.remoteAddress`. Behind a trusted HTTPS proxy that address is the proxy itself, so one public client could exhaust the proxy-wide request allowance and cause unrelated clients to receive HTTP 429 responses. The new identity resolution preserves the limiter while separating independently forwarded client IPs.

## Deployment requirement

A production reverse proxy must overwrite or append `X-Forwarded-For` correctly and must itself be listed explicitly in `trustedProxyAddresses`. Operators must not add untrusted intermediary addresses to the trusted set. Public-testnet or mainnet readiness still requires real Internet abuse testing of the complete proxy and node deployment; these unit tests do not substitute for that evidence.
