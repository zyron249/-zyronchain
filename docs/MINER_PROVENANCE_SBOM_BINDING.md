# Miner provenance-to-SBOM binding

Miner release promotion treats the promoted miner artifacts and their per-platform SBOMs as one provenance identity. A provenance reference is not sufficient merely because it has a canonical immutable URL and SHA-256 fragment.

For a promotion attempt, `verify-miner-release-provenance-subjects.mjs` derives the ordered Windows, macOS and Linux artifact subjects from `docs/miner-release-promotion.json`. It also derives one SBOM subject for each platform from the exact promoted artifact basename plus `.sbom.cdx.json` and the lowercase SHA-256 digest on the corresponding `windowsSbom`, `macosSbom`, or `linuxSbom` evidence reference.

The canonical provenance subject document is schema version 2 and contains the exact release version, exact lowercase 40-hex source commit, ordered `artifactSubjects`, and ordered `sbomSubjects`, terminated by a newline. The SHA-256 of those exact bytes must equal the digest fragment on the canonical provenance evidence reference.

This makes the provenance gate fail closed when an SBOM is missing, duplicated, renamed, swapped across platforms, taken from another release, or replaced by different bytes after artifact identities were fixed. Artifact/SBOM digest aliasing is also rejected. Regression tests cover missing and duplicate subjects, cross-platform swaps, artifact and SBOM digest drift, mutable or digestless provenance, and release/source drift.

This is a local promotion-integrity control only. It does not create or publish an SBOM or provenance artifact, does not sign or notarize software, does not grant OIDC or repository write authority, and does not activate public mining, public testnet, or mainnet. Existing activation and publication gates remain fail closed until their independent evidence requirements are satisfied.
