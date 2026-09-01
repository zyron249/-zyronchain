# Linux miner signing promotion boundary

Miner release promotion schema v4 requires Linux signing evidence in addition to the existing Windows signing and macOS signing/notarization evidence. The inactive canonical policy keeps `linuxSigning` null; a promotion attempt cannot satisfy `platformSigningVerified=true` without a reviewable Linux signing evidence reference.

The only accepted Linux signing role paths are `evidence/linux-signing.json` and `evidence/linux-signature.json` at the exact promoted `sourceCommit`, with a lowercase 64-hex `#sha256=` binding. Mutable branch references, unrelated evidence paths and digestless references fail closed.

The signing digest is not a generic approval token. `verify-miner-release-signing-subjects.mjs` derives the version-2 canonical signing-subject document from the exact `releaseVersion`, `sourceCommit`, promoted Linux artifact `{platform,name,sha256}` and its canonical same-release SBOM `{name,sha256}`. The terminal digest on `linuxSigning` must equal the SHA-256 of those exact canonical bytes. Missing evidence, cross-platform substitution, filename or digest drift, mutable/non-canonical SBOM evidence and artifact/SBOM digest aliasing therefore fail closed.

This is an evidence-identity gate only. It does not select or provision a private signing key, grant GitHub OIDC or write authority, publish a release asset, make an existing release immutable, activate public mining, or establish public-testnet/mainnet readiness. Real signer custody and independently reviewable release evidence remain external stop-ship requirements.
