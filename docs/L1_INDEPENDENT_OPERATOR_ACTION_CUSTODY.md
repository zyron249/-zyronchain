# Independent Operator Evidence Action Custody

The independent-operator challenge workflow is readiness evidence infrastructure, not proof that independent operation has already been achieved.

Its GitHub Actions dependencies are pinned to reviewed immutable commit SHAs and checkout credential persistence is disabled. The workflow must continue to preserve the synthetic-only boundary: the positive test vector must report `independenceProven=false` and `externalReviewRequired=true`, and founder-assisted evidence must fail closed.

Archived evidence remains SHA-256 bound, names artifacts with the exact source commit and run attempt, fails on missing files, and retains artifacts for 90 days. These controls protect evidence provenance; they do not satisfy public-testnet or mainnet activation gates by themselves.
