# Miner Package Action Custody

`Miner Package CI` is a **local, non-publishable packaging evidence boundary**, not release publication or public-mining activation evidence.

The audited Linux/macOS path may materialize exactly one local miner candidate only after the descriptor-relative packaging custody gate admits the platform. That candidate must remain activation-gated, carry `candidate-integrity.json` bound to the exact workflow source commit, and now receive a locally generated `SHA256SUMS` that is immediately re-verified against the exact regular-file set. The checksum stage fails closed on malformed or duplicate records, non-canonical/traversal paths, missing or extra files, digest mismatch, symlinks/non-regular entries, stale publication temporaries, and an unsafe checksum-manifest leaf.

Windows and other unaudited packaging platforms remain fail-closed before `miner-release` state is created. The workflow continues to exercise the supported OS/Node matrix, locked installation, typecheck, miner security checks, inactive-network-profile assertions, build, and platform-appropriate regressions without granting an unsupported packaging fallback.

The dedicated action-custody policy verifier pins checkout/setup-node actions to reviewed immutable commit SHAs, requires checkout credential persistence to remain disabled, requires the local integrity/checksum verification path, and rejects publication authority such as artifact upload, attestation/OIDC, release writes, or `contents: write`. Local `SHA256SUMS` generation is integrity evidence only and does not authorize publication.

`Miner Release Candidate CI` applies the same containment model. Audited POSIX runners may construct one local inactive candidate and verify source-commit integrity plus checksums; Windows must exercise the real package entrypoint and fail before candidate state exists. Neither workflow may upload, attest, sign, publish, or silently activate mining.

Platform signing, provenance/attestation, SBOM binding, immutable release publication, website download activation, public mining, public-testnet activation, and mainnet activation remain separate fail-closed gates. Passing these CI checks must not be described as evidence that any of those gates are complete.
