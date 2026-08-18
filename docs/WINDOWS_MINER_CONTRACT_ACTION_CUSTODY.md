# Windows Miner Contract Action Custody

The Windows miner package-contract workflow is part of the release verification boundary. It must use immutable reviewed action SHAs, keep checkout credentials disabled, preserve the exact Node 22.23.2 runtime, and execute the canonical Windows package-contract verifier.

The focused custody policy CI fails closed if these invariants drift. This hardening does not publish miner assets, sign Windows binaries, activate public mining, or change public-testnet/mainnet activation policy.

A green package-contract workflow is regression evidence only. Public distribution still requires immutable versioned release assets, matching checksums/SBOM/provenance, platform-signing evidence where required, and explicit release/public-mining authorization.
