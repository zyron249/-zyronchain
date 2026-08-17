# Standalone L1 artifact-operator action custody

The release-artifact operator rehearsal is a security-sensitive supply-chain boundary because it builds the canonical L1 package, installs it in a clean operator context, and archives commit-bound evidence.

The workflow therefore pins `actions/checkout`, `actions/setup-node`, and `actions/upload-artifact` to reviewed immutable commit SHAs, disables checkout credential persistence, uses least-privilege `contents: read`, installs locked dependencies, builds the canonical package, runs the clean artifact-operator rehearsal, and uploads evidence named with the exact source commit/run attempt for 90 days.

`.github/scripts/verify-l1-artifact-operator-action-custody.mjs` and its dedicated policy workflow fail closed if those action pins, credential boundary, locked install/build/rehearsal steps, commit-bound artifact naming, missing-file failure behavior, or retention invariants drift.

This hardening is supply-chain evidence only. It does not authorize public mining, public testnet, mainnet, consensus changes, or activation-gate changes.
