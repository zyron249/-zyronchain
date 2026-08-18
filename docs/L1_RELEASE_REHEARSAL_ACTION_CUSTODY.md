# Standalone L1 Release Rehearsal Action Custody

The release-rehearsal workflow is a non-publishing evidence path. Its checkout, Node setup and artifact-upload actions are pinned to reviewed immutable SHAs, and checkout credential persistence is disabled.

The focused policy CI fail-closes if action refs become mutable, checkout credentials are persisted, or the Node 22 locked-install/typecheck/test/runtime-audit, deterministic double-pack comparison, SPDX SBOM, SHA-256 verification, commit/run-attempt-bound artifact naming, fail-on-missing upload, or 90-day retention controls are weakened.

This evidence does not authorize a public release, public mining, public testnet, or mainnet activation. Those gates remain independently controlled and require their existing external and governance evidence.
