# Miner checksum evidence: fail-closed boundary

`checksumsVerified=true` is a release stop-ship assertion. It must not be inferred from candidate CI, a reconstructed metadata digest, or the mere presence of a `SHA256SUMS` release asset.

For an active miner promotion, `evidence.checksums` must reference the canonical `evidence/checksums.json` file at the exact promoted `sourceCommit`, with a terminal `#sha256=` digest over the exact Git blob bytes. The checked-out evidence file must be a regular non-symlink file and must match those immutable source-commit bytes.

The structured evidence uses schema version 3 and binds all three promoted Windows/macOS/Linux artifact names and SHA-256 digests, their corresponding canonical SBOM names and SHA-256 digests, and the canonical same-release `SHA256SUMS` asset URL plus its own exact SHA-256 byte identity. Artifact, SBOM, checksum-manifest, and evidence byte identities must not be aliased.

The evidence must also record an explicit positive verification result. Only bounded approved checksum-verification methods are accepted, and the verification tool identity is constrained. False or unknown verification states, legacy metadata-only commitments, mutable refs, release-asset substitution for the evidence document, subject drift, checksum-manifest drift, working-tree substitution, symlink substitution, and digest mismatch fail closed.

This evidence gate does not authorize public mining, public testnet, or mainnet activation. Those remain separately gated by the canonical promotion policy and independent readiness evidence.
