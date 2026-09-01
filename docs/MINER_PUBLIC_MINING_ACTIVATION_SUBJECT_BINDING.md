# Miner public-mining activation subject binding

Public-mining activation remains fail-closed. A positive promotion state does not grant mining, publication, signing, OIDC, testnet, or mainnet authority by itself.

For an activation attempt, `evidence.publicMiningActivation` must carry a terminal lowercase SHA-256 digest that commits to a deterministic schema-v2 document containing the exact `releaseVersion`, exact 40-hex `sourceCommit`, and ordered Windows, macOS, and Linux subjects. Each subject contains the promoted artifact basename and SHA-256 plus the corresponding canonical `${artifact}.sbom.cdx.json` basename and SBOM evidence SHA-256.

The verifier rejects missing or digestless SBOM evidence, mutable/non-canonical SBOM identity, duplicate or cross-platform artifact/SBOM identities, artifact or SBOM filename/digest drift, and any SBOM digest that aliases a promoted artifact digest. Changing any bound release, source, artifact, or SBOM identity therefore invalidates activation evidence rather than silently accepting substitution.

This control is regression-enforced by `l1/scripts/test-miner-public-mining-activation-subjects.mjs` through the Miner Release Promotion Gate CI. It supplements, and does not weaken or replace, the independent signing, provenance, checksum, immutable-release, publication, public-mining activation, public-testnet, or mainnet gates.
