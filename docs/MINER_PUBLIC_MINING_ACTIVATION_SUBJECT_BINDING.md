# Miner public-mining activation subject binding

Public-mining activation remains fail-closed. A positive promotion state does not grant mining, publication, signing, OIDC, testnet, or mainnet authority by itself.

For an activation attempt, `evidence.publicMiningActivation` must reference `evidence/public-mining-activation.json` at the exact lowercase 40-hex `sourceCommit` through the canonical GitHub blob URL with a terminal lowercase `#sha256=` digest. The referenced path must be a regular Git blob at that exact commit. The checked-out path must also be a regular non-symlink file whose bytes are identical to the exact source-commit blob. Mutable refs, missing/non-regular blobs, digest mismatch, working-tree substitution, and symlink substitution fail closed.

The structured activation record uses schema version 3 and binds the exact `releaseVersion` plus ordered Windows, macOS, and Linux subjects. Each subject contains the promoted artifact basename and SHA-256 and the corresponding canonical same-release `${artifact}.sbom.cdx.json` basename and SBOM SHA-256. The record must carry an explicit positive `verification.verified=true`, an approved activation-verification method (`public-mining-activation-review` or `release-activation-verification`), and a bounded verification-tool identity. Unknown fields, false verification, unknown methods, subject drift, release drift, duplicate/cross-platform identities, and digest aliasing fail closed.

The activation evidence file has its own immutable byte identity and may not alias any promoted artifact, SBOM, or other promotion evidence role. This control is regression-enforced by `l1/scripts/test-miner-public-mining-activation-subjects.mjs` through the Miner Release Promotion Gate CI.

This gate supplements, and does not weaken or replace, the independent signing, provenance, checksum, SBOM verification, immutable-release, publication, public-mining activation, public-testnet, or mainnet gates. Passing it is evidence about one release-promotion control only and must not be presented as public-mining, public-testnet, or mainnet readiness.
