# Legacy explorer browser security

The Flask explorer under `templates/` belongs to the archived Python compatibility testnet, not the canonical standalone TypeScript L1.

Explorer summary responses and on-chain display fields are treated as untrusted browser input. Dynamic transaction IDs, addresses, miner identifiers and numeric display values are rendered through DOM nodes with `textContent`; dynamic route segments are passed through `encodeURIComponent` before being assigned to links. API-derived values must not be concatenated into `innerHTML`, `insertAdjacentHTML`, or `document.write`.

`tests/test_explorer_template_security.py` is the regression gate for this boundary. This hardening does not change consensus behavior and does not imply public-testnet or mainnet readiness.
