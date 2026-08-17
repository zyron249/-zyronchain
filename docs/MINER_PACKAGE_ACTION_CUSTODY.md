# Miner Package Action Custody

`Miner Package CI` is a packaging and regression boundary, not public-mining activation evidence. It builds self-contained miner candidates for Linux, macOS and Windows under Node 22 and Node 24, but the bundled network profile must remain fail closed until a separate reviewed activation explicitly opens public mining.

The workflow therefore pins checkout, setup-node and artifact upload actions to reviewed immutable commit SHAs and disables checkout credential persistence. A dedicated policy verifier rejects mutable action refs or drift in the matrix, locked install/typecheck checks, fail-closed network profile assertion, platform-specific regression coverage, SBOM generation, production dependency pruning, package creation, exit-78 no-custody smoke, SHA-256 manifest, fail-on-missing artifact upload, or retention policy.

These controls protect package provenance and CI custody. They do not publish GitHub Release assets, satisfy platform signing/notarization requirements, authorize a website download CTA, or change `publicMiningActivated`, public-testnet, or mainnet activation gates.