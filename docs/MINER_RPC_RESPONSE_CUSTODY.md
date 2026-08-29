# Miner RPC rejection custody

The standalone miner treats a rejected RPC response body as an explicit resource-custody boundary.

Responses that omit or advertise an incompatible `x-zyron-rpc-version` remain fail-closed and now trigger best-effort cancellation of an unconsumed streaming body before the protocol rejection escapes. The same cleanup applies when the bounded miner response reader rejects malformed `Content-Length` or a declared length above the existing 64 KiB ceiling before acquiring a body reader.

Cleanup is intentionally subordinate to validation: a body-cancellation failure never converts a rejected response into an accepted one and never replaces the original protocol or size error. Existing HTTPS/loopback restrictions, redirect rejection, 64 KiB response limit, JSON depth and structural-token limits, chain/genesis identity checks, protocol-v5 activation gating, local encrypted key custody and mining-claim validation remain unchanged.

This change is availability/resource-custody hardening only. It is not evidence that public mining, public testnet, or mainnet is ready or activated. Publication and activation remain blocked by their existing signing, provenance, external-review, custody and launch gates.
