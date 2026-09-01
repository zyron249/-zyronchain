# Miner promotion SBOM fail-closed invariant

The miner release promotion policy has two complementary SBOM controls:

1. The baseline promotion verifier requires `sbomVerified=true` for every active promotion attempt. An inactive fail-closed policy may keep `sbomVerified=false` only while release identity, assets, digests, and evidence remain unset and all activation/publication flags remain false.
2. The dedicated SBOM evidence verifier independently validates the per-platform Windows, macOS, and Linux SBOM evidence and its canonical immutable release bindings.

These controls are intentionally redundant. A future change must not treat the dedicated SBOM evidence gate as a reason to allow the baseline promotion contract to carry `sbomVerified=false`, and must not weaken the dedicated gate because the baseline boolean is true.

`l1/scripts/test-miner-release-promotion-sbom-baseline.mjs` is the regression lock for this invariant. It proves that an otherwise fully evidenced active policy is rejected when only `sbomVerified` is false.

This hardening does not activate public mining, authorize release publication, or establish public-testnet/mainnet readiness. Those gates remain independently fail-closed.
