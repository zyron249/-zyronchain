# Private-testnet preflight action custody

The private-testnet preflight workflow is deployment/readiness evidence, not public-testnet activation evidence. Its checkout, runtime setup and evidence upload actions are pinned to reviewed immutable commit SHAs, and checkout credential persistence is disabled before repository-controlled verification scripts execute.

The workflow must preserve least-privilege `contents: read`, Node.js 24, deterministic double execution of the private-testnet preflight verifier, the connected Render Free-profile smoke-only verification, SHA-256 evidence, commit/run-attempt-bound artifact naming, fail-on-missing upload behavior and 90-day retention.

The focused custody policy CI fails closed if those action pins, credential isolation, or evidence invariants drift. Passing this workflow does not prove sustained uptime, independent failure domains, public-testnet readiness or mainnet readiness. Those external gates remain separately tracked and activation flags remain fail-closed.
