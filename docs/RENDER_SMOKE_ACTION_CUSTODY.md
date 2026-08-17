# Render private-testnet smoke action custody

The Render private-testnet smoke workflow is regression evidence only. It does not prove sustained uptime, independent failure domains, public-testnet activation readiness, or mainnet readiness.

The workflow must use reviewed immutable action SHAs, disable checkout credential persistence, run on Node.js 24 with `npm ci`, build the canonical L1, execute the four-validator `render-private-testnet.mjs --smoke` rehearsal, and archive a commit/run-attempt-bound smoke log for 90 days. Missing smoke evidence fails the workflow rather than silently producing an incomplete artifact.

`l1/scripts/verify-render-smoke-action-custody.mjs` and the dedicated policy CI fail closed if these custody or evidence invariants drift. Public-testnet, mainnet, mining, consensus/finality, and sustained-hosting activation gates are intentionally unchanged.
