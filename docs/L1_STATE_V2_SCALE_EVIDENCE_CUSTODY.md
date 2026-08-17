# State-v2 Scale Evidence Custody

The `Standalone L1 State-v2 Scale Evidence CI` workflow is a recovery/capacity regression boundary. It runs the canonical Node 24 build and 100,000-account State-v2 restart/GC benchmark from locked dependencies, normalizes and archives the result, and uploads commit/run-attempt-bound evidence with a SHA-256 manifest.

The workflow must use reviewed immutable GitHub Action SHAs, disable checkout credential persistence, fail if expected evidence files are missing, and retain evidence for the configured review window. `l1/scripts/verify-state-v2-scale-action-custody.mjs` fail-closes if those invariants drift.

This evidence is **CI regression evidence only**. GitHub-hosted runner measurements do not establish the peak-memory/capacity characteristics of the intended deployment hardware and therefore do not satisfy issue #383 or any public-testnet/mainnet activation requirement. Target-hardware evidence must remain separately collected, commit/environment-bound, reviewed, and archived before those gates can close.
