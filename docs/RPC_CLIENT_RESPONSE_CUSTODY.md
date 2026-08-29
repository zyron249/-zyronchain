# RPC client response custody

The bounded RPC client treats response-size rejection as fail-closed independently of stream cleanup behavior.

- `Content-Length` remains syntax-checked and must not exceed the configured response ceiling.
- Unknown-length/chunked responses allocate incrementally and never beyond the configured byte ceiling.
- If streamed bytes exceed the ceiling, reader cancellation is initiated best-effort but its Promise is not awaited. A stalled or rejecting cleanup operation therefore cannot delay or replace the original oversize rejection.
- JSON parsing still occurs only after bounded byte collection and remains subject to nesting and structural-token limits.
- RPC API-version checks and canonical CLI security policy remain unchanged.

This hardening improves availability/resource custody only. It does not weaken activation, consensus, finality, mining, key-custody, or release gates and is not evidence of public mining, public testnet, or mainnet readiness.
