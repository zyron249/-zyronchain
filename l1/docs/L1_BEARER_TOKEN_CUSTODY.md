# Bearer-token comparison custody

Consensus bearer-token authentication keeps its existing exact-length check and `timingSafeEqual()` comparison semantics. The mutable `Buffer` instances created from the presented and configured credentials are operation-scoped and are explicitly overwritten in a `finally` path after each comparison, including mismatch and exception paths.

This hardening only reduces the lifetime of mutable comparison copies. The original JavaScript strings remain managed by the runtime and cannot be reliably zeroized in place. Canonical auth-token parsing, HTTPS/proxy requirements, RPC/P2P authentication, rate limiting, consensus/finality validation, and activation gates are unchanged.

This is credential-memory-lifetime hardening. It is not evidence of public mining, public testnet, or mainnet readiness.
