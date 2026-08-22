# Miner release asset digest binding

The canonical miner promotion policy is fail-closed and uses schema version 2. In addition to exact GitHub Release asset URLs, it carries one expected SHA-256 digest for each supported end-user platform: Windows, macOS and Linux.

While promotion is inactive, every asset URL and every platform digest remains `null`. Supplying only a URL or only a digest is treated as an attempted promotion and therefore cannot pass without the complete release identity, evidence and activation gates.

A live promotion requires all three platform URLs to be bound to the exact `releaseVersion`, and all three `assetSha256` values to be lowercase 64-hex SHA-256 digests. The exact platform key set is enforced so missing or unexpected platform material fails closed.

These digests are an artifact-identity contract, not proof that the referenced bytes have been independently reviewed. Release operators must still verify the published artifacts against the signed/reviewed checksum manifest and provide the existing platform-signing/notarization, provenance, immutable-release and public-mining activation evidence before `publicationAllowed` can become true.

This change does not activate public mining, publish an end-user miner, or establish mainnet/public-testnet readiness. Issue #390 remains blocked on real signed immutable release artifacts and intentional public-mining activation.
