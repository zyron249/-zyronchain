# Miner release promotion evidence binding

Miner release promotion remains fail-closed until every publication and public-mining gate is explicitly satisfied. The canonical inactive policy carries no release identity, assets, or evidence.

For a future promotion, the policy verifier now binds the complete Windows/macOS/Linux asset set to the exact `releaseVersion` tag and requires every evidence reference to be reviewable and immutable enough for automated policy checking. Evidence must reference either the exact 40-hex `sourceCommit`, an asset under the exact release tag, or the exact release tag page, and must include an explicit `#sha256=<64-hex>` digest binding. Mutable branch references, arbitrary placeholder strings, cross-tag assets/evidence, and digest-free references fail closed.

These checks do not prove that signing, notarization, provenance, checksums, release immutability, or public-mining activation are valid by themselves. The corresponding boolean gates still require independent reviewed evidence and must remain false until that evidence actually exists. A repository path or URL that passes shape validation is only an identity/digest binding; it is not a substitute for external review.

No public miner publication, public testnet activation, mainnet activation, or website live-mining claim is authorized by this hardening change.