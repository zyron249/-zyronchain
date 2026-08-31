# Miner Package Action Custody

`Miner Package CI` is a **local, non-publishable packaging evidence boundary**, not release publication or public-mining activation evidence.

The audited Linux/macOS path may materialize exactly one local miner candidate only after the descriptor-relative packaging custody gate admits the platform. That candidate must remain activation-gated. It carries a verified CycloneDX `miner-sbom.cdx.json`, then a deterministic `miner-provenance.json` that binds package/version/platform/architecture, the exact lowercase source commit, and the SHA-256 digest of that verified SBOM. The provenance document is explicitly marked local-evidence-only, unsigned and unpublished. It is written and immediately re-derived before `candidate-integrity.json` freezes the candidate, so both provenance and SBOM are subsequently covered by candidate integrity and the exact-file-set `SHA256SUMS` layer.

The local provenance stage fails closed on malformed package identity or metadata, unaudited platforms, non-canonical source commits, SBOM substitution/tamper, symlink or non-regular SBOM/provenance paths, pre-existing provenance output, and provenance drift. The checksum stage separately fails closed on malformed or duplicate records, non-canonical/traversal paths, missing or extra files, digest mismatch, symlinks/non-regular entries, stale publication temporaries, and an unsafe checksum-manifest leaf.

Windows and other unaudited packaging platforms remain fail-closed before `miner-release` state is created. The workflow continues to exercise the supported OS/Node matrix, locked installation, typecheck, miner security checks, inactive-network-profile assertions, build, and platform-appropriate regressions without granting an unsupported packaging fallback.

The dedicated action-custody policy verifier pins checkout/setup-node actions to reviewed immutable commit SHAs, requires checkout credential persistence to remain disabled, requires the local integrity/checksum verification path, and rejects publication authority such as artifact upload, external attestation/OIDC, release writes, or `contents: write`. Local SBOM, provenance and `SHA256SUMS` generation are integrity evidence only and do not authorize publication.

`Miner Release Candidate CI` applies the same containment model. Audited POSIX runners may construct one local inactive candidate and verify source-commit integrity plus the local evidence chain; Windows must exercise the real package entrypoint and fail before candidate state exists. Neither workflow may upload, externally attest, sign, publish, or silently activate mining.

Platform signing, GitHub/OIDC provenance attestation, immutable release publication, website download activation, public mining, public-testnet activation, and mainnet activation remain separate fail-closed gates. Passing these CI checks must not be described as evidence that any of those gates are complete.
