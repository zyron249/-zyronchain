# Miner release archive custody

Windows miner ZIP publication runs as a separate release step and must re-bind the canonical `l1/miner-release` directory before it discovers bundles, removes a stale ZIP, invokes PowerShell archive creation, or validates the resulting archive.

`package-windows-miner-zip.mjs` therefore uses the same `bindMinerReleaseRoot()` boundary as the main miner package builder. A symlink, junction, non-directory object, or canonical path outside the L1 project's direct `miner-release` child fails closed before archive operations begin.

This boundary is defense-in-depth for archive publication. It does not close the stronger destination-directory replacement findings tracked separately in #636 and #683, and it is not evidence of public-mining, public-testnet, or mainnet readiness. Signing, provenance, immutable-release, checksum, and explicit activation gates remain required.