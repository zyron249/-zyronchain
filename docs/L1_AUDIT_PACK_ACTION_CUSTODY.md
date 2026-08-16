# External audit-pack action custody

The external audit-pack workflow is a security-sensitive handoff boundary because it emits the commit-bound audit manifest, runtime SBOM, SHA-256 checksums, and retained downloadable artifacts used for external review.

The workflow therefore pins checkout, setup-node, and upload-artifact to reviewed immutable commit SHAs and disables checkout credential persistence. A dedicated policy verifier fails closed if those refs drift, mutable refs appear, checkout credentials are persisted, or core handoff controls such as locked installation, deterministic manifest comparison, runtime dependency audit, SBOM generation, SHA-256 checksums, or retention policy are removed.

This control strengthens supply-chain custody only. It does not constitute an independent external audit, public-testnet evidence, public-mining authorization, or mainnet readiness. Those activation gates remain independently fail-closed.
