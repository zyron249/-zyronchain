# Miner release promotion action custody

The miner release promotion gate protects a high-value publication boundary, so its GitHub Actions dependencies are pinned to reviewed immutable commit SHAs and checkout credentials are not persisted.

This policy preserves the exact Node.js 22.23.2 runtime plus the canonical fail-closed promotion verifier and its positive/negative vectors. It also requires the provenance, platform-signing, and checksum subject-binding verifiers and their regressions to remain present in the read-only promotion workflow. The checksum binding specifically prevents a canonical checksum evidence reference from satisfying promotion unless its terminal digest commits to the exact ordered Windows, macOS, and Linux promoted artifact filenames and SHA-256 identities.

A passing custody policy proves only that the CI execution boundary and required local policy checks have not drifted; it does not prove platform signing, notarization, external checksum publication, immutable GitHub Release publication, public-mining activation, public-testnet readiness, or mainnet readiness.

`docs/miner-release-promotion.json` remains the canonical fail-closed release policy. Publication and public mining must remain disabled until their separately reviewed evidence is complete.
