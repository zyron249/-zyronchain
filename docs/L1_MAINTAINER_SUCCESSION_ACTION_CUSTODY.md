# Maintainer succession evidence action custody

The maintainer-succession workflow is security/release evidence, not proof that independent succession has occurred.

Its GitHub Actions supply-chain boundary is fail-closed: checkout, Node setup, and artifact upload actions are pinned to reviewed immutable commit SHAs; checkout credentials are not persisted; Node 24 runs the canonical succession verifier twice and the outputs must be byte-identical; the archived policy/result receive SHA-256 evidence; artifact names are bound to the source commit and run attempt; missing evidence fails the upload; retention remains 90 days.

`l1/scripts/verify-maintainer-succession-action-custody.mjs` and the dedicated policy CI reject action-reference drift, restored checkout credential persistence, or removal of those evidence controls.

This control does not satisfy the external independence requirements tracked by public-testnet/mainnet activation. It does not change consensus, finality, validator membership, mining, or any activation flag.
