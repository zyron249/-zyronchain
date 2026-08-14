# RPC compatibility security boundary

ZyronChain RPC compatibility is fail-closed. Canonical RPC requests use the `x-zyron-rpc-version` header and canonical JSON responses must explicitly advertise the same API version.

For RPC API version 1:

- requests send `x-zyron-rpc-version: 1`;
- every canonical JSON response path, including overload and error responses, must send `x-zyron-rpc-version: 1`;
- canonical CLI, miner, and peer HTTP clients must reject a missing response-version header as well as a mismatched version;
- response-version validation occurs before a response body is trusted or parsed;
- `/rpc-info` remains an informational endpoint and does not weaken the header contract.

A missing response-version header is not treated as legacy compatibility. Accepting an unversioned response would allow a legacy, misrouted, or intermediary-modified endpoint to bypass the intended API compatibility gate.

This contract does not change authentication, TLS/proxy requirements, consensus rules, mining activation, public-testnet activation, or mainnet activation. Public network readiness remains evidence-gated by the canonical readiness and launch-authorization controls.
