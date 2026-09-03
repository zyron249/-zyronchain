# Miner immutable-release SBOM subject binding

The miner release promotion gate treats immutable-release evidence as a fail-closed verification boundary for the exact promoted release. For an active promotion, `evidence.immutableRelease` must reference the canonical `evidence/immutable-release.json` regular Git blob at the exact promoted `sourceCommit`, with a terminal SHA-256 digest over those exact blob bytes. The checked-out file must be a regular non-symlink file and must match the exact source-commit blob.

The structured immutable-release document uses schema version 3 and binds:

- the exact release version;
- ordered Windows, macOS, and Linux promoted artifact filenames and SHA-256 digests;
- the corresponding per-platform SBOM filenames and SHA-256 evidence digests; and
- an explicit positive immutable-release verification result with an approved verification method and bounded tool identity.

Each SBOM filename is derived from the promoted artifact basename by appending `.sbom.cdx.json`. Artifact filenames, artifact digests, SBOM filenames, and SBOM digests must remain distinct in their respective sets, and an SBOM digest may not alias any promoted artifact digest. Metadata-only legacy commitments, false or unknown verification, mutable refs, digest mismatch, renamed or drifted subjects, working-tree substitution, symlinks, and cross-platform swaps fail closed.

The containing source commit is bound by the immutable Git object reference rather than embedded in the evidence bytes, avoiding a self-referential commit-hash requirement.

This boundary does not itself sign or notarize artifacts, mint provenance, upload or publish releases, grant OIDC or repository write authority, activate public mining, activate a public testnet, or authorize mainnet. Those gates remain independent and must continue to provide their own evidence.
