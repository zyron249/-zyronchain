# Miner publication evidence fail-closed boundary

Publication authorization is a distinct release security boundary. A positive `publicationAllowed=true` state is valid only when the promotion policy carries canonical `publication` evidence at `evidence/publication.json`.

The publication evidence reference must point to the exact 40-hex `sourceCommit` Git blob and end in a lowercase SHA-256 digest that matches the immutable blob bytes. The checked-out evidence path must exist as a regular, non-symlink file and its bytes must match the exact source-commit blob. Mutable refs, release-page substitution, renamed evidence paths, working-tree replacement, symlink substitution, digest drift, or evidence-byte aliasing with promoted artifacts, SBOMs, or another evidence role fail closed.

The structured publication record uses schema version 1 and contains exactly the release version, ordered Windows/macOS/Linux artifact and canonical per-platform SBOM subjects, plus a verification object. Verification must be explicitly positive and use an approved bounded method/tool identity. Release drift, missing/duplicated/cross-platform subjects, SBOM drift, unknown fields, false verification, and unapproved methods are rejected.

This gate does not publish a release, upload artifacts, grant GitHub write/OIDC authority, activate public mining, authorize a public testnet, or establish mainnet readiness. Those boundaries remain independently gated.
