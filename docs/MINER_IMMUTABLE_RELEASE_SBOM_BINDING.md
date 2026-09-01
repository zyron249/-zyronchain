# Miner immutable-release SBOM subject binding

The miner release promotion gate treats immutable-release evidence as a fail-closed commitment to the exact release identity. For an active promotion, the canonical immutable-release document is schema version 2 and binds:

- the exact release version;
- the exact lowercase source commit;
- ordered Windows, macOS, and Linux promoted artifact filenames and SHA-256 digests; and
- the corresponding per-platform SBOM filenames and SHA-256 evidence digests.

Each SBOM filename is derived from the promoted artifact basename by appending `.sbom.cdx.json`. Artifact filenames, artifact digests, SBOM filenames, and SBOM digests must remain distinct in their respective sets, and an SBOM digest may not alias any promoted artifact digest. Missing, mutable, digestless, renamed, cross-platform-swapped, duplicated, or drifted subjects fail closed.

This binding is only a verification boundary. It does not sign or notarize artifacts, mint attestations, upload or publish releases, grant OIDC or repository write authority, activate public mining, activate a public testnet, or authorize mainnet. Those gates remain independent and must continue to provide their own evidence.
