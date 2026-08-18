# Unix Miner Archive Contract Action Custody

The Unix miner archive contract workflow is part of the miner release-verification boundary. It must use reviewed immutable GitHub Action SHAs, must not persist checkout credentials, and must preserve the exact Node.js 22.23.2 runtime used by the package-contract verifier.

The focused custody policy rejects mutable or drifted action refs, checkout credential persistence, runtime drift, or removal of the canonical `node scripts/test-unix-miner-package-contract.mjs` check.

Passing this workflow only proves the repository's Linux/macOS archive packaging contract on GitHub-hosted CI. It does not authorize publication, public mining, public testnet, or mainnet. Those activation and release-promotion gates remain independent and fail closed.
