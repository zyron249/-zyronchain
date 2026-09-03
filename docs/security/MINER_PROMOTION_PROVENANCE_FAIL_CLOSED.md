# Miner promotion provenance evidence boundary

Miner release promotion treats provenance as external security evidence, not as a metadata checkbox. The canonical inactive promotion policy remains fail-closed and does not authorize publication or public mining.

When any promotion state is requested, `evidence.provenance` must reference `evidence/provenance.json` or `evidence/attestation.json` at the exact promoted `sourceCommit`. The terminal `#sha256=` value must match the bytes of that exact regular-file Git blob. The checked-out evidence must also be a regular non-symlink file whose bytes match the immutable source blob, so a mutable branch ref, missing object, symlink substitution, or working-tree replacement cannot satisfy the gate.

The evidence document uses schema version 3 and contains exactly the release version, the ordered Windows/macOS/Linux artifact subjects, the ordered same-platform SBOM subjects, and a verification object. Each subject must exactly match the promoted release identity and digest. Verification must be explicitly positive, use an approved provenance/attestation verification method, and carry a bounded tool identity. Unknown fields, metadata-only legacy commitments, false verification, subject drift, release drift, or malformed JSON fail closed.

The containing source commit is bound by the immutable Git URL/object rather than duplicated inside the evidence bytes. Embedding a file's own containing commit hash in that same file would create a self-referential commit-hash requirement that cannot be constructed.

This verifier does not create provenance, grant OIDC or release-write authority, sign or notarize binaries, publish GitHub Release assets, enable website downloads, or activate public mining/testnet/mainnet. Real build-system or attestation evidence must still be produced and independently reviewed before the promotion policy can truthfully become active.
