# Miner SBOM verification evidence: fail-closed boundary

The miner release promotion policy does not treat per-platform SBOM URLs or caller-supplied SHA-256 fragments as proof that an SBOM was actually verified.

For an active promotion, `evidence.sbomVerification` must reference `evidence/sbom-verification.json` at the exact 40-hex `sourceCommit` using the canonical GitHub blob URL plus a lowercase `#sha256=` digest. The referenced path must be a regular Git blob at that commit. The checked-out path must also remain a regular non-symlink file with byte identity equal to the exact source-commit blob. Mutable refs, digest mismatch, working-tree substitution, symlink substitution, missing evidence, or non-regular files fail closed.

The structured record uses schema version 1 and binds the exact `releaseVersion`; Windows, macOS, and Linux promoted artifact filenames and SHA-256 identities; and each artifact's canonical same-release CycloneDX SBOM filename and SHA-256 identity. The verification result must explicitly set `verified: true`, use an approved SBOM verification method (`cyclonedx-sbom-verification` or `release-sbom-verification`), and provide a bounded verification-tool identity. Subject drift, release drift, unknown fields, false verification, and unknown methods fail closed.

The evidence record has its own byte identity and may not alias an artifact, SBOM, or another promotion evidence role. This gate supplements the existing per-platform SBOM release-subject checks; it does not weaken signing, provenance, checksum, immutable-release, publication, or public-mining activation gates.

Passing this repository gate is evidence about one release-promotion control only. It does not by itself authorize or claim public mining, public testnet, or mainnet readiness.
