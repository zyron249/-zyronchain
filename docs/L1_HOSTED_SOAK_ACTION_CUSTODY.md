# Hosted-duration soak action custody

The hosted-duration soak evidence workflow is a security-sensitive verification boundary because it archives the synthetic verifier evidence used to validate the sustained-hosting readiness policy. Synthetic CI is regression evidence only and must never be relabeled as sustained uptime, independent-operator, public-testnet activation, or mainnet evidence.

The workflow therefore pins checkout, setup-node, and upload-artifact to reviewed immutable SHAs, disables checkout credential persistence, keeps `contents: read` permissions, runs on Node 24, verifies both the accepted synthetic vector and a rejected height-regression vector, preserves explicit non-activation assertions, records SHA-256 checksums, and uploads commit/run-attempt-bound evidence with fail-on-missing behavior and 90-day retention.

`.github/scripts/verify-l1-hosted-soak-action-custody.mjs` is a fail-closed repository policy check. Mutable action refs, credential persistence, or removal of the hosted-soak evidence invariants must fail CI. These controls do not change `sustainedUptimeEvidence`, public-testnet activation, mainnet activation, or any consensus/mining behavior.
