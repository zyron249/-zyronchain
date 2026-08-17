# Miner release promotion action custody

The miner release promotion gate protects a high-value publication boundary, so its GitHub Actions dependencies are pinned to reviewed immutable commit SHAs and checkout credentials are not persisted.

This policy preserves the exact Node.js 22.23.2 runtime plus the canonical fail-closed promotion verifier and its positive/negative vectors. A passing custody policy proves only that the CI execution boundary has not drifted; it does not prove platform signing, notarization, immutable GitHub Release publication, public-mining activation, public-testnet readiness, or mainnet readiness.

`docs/miner-release-promotion.json` remains the canonical fail-closed release policy. Publication and public mining must remain disabled until their separately reviewed evidence is complete.
