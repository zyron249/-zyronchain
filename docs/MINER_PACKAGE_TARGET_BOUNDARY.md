# Miner Package Target Boundary

Issue #846 hardens the local miner release-candidate boundary used by #390.

`l1/scripts/package-miner.mjs` must resolve an explicitly reviewed platform/architecture pair before it binds or materializes any `miner-release` candidate path. The canonical resolver currently permits only:

- Linux x64
- Linux arm64
- macOS x64
- macOS arm64

Windows remains fail-closed because the repository's audited packaging custody path is POSIX-only. Other Node architecture identifiers, including ia32 and ppc64, are not release targets merely because Node can report them at runtime. A future target requires an explicit reviewed code change plus regression coverage; target names must never be derived into release-shaped candidates from an unbounded runtime string.

`l1/scripts/test-miner-package-target.mjs` locks the supported target matrix and rejects unsupported platform/architecture combinations. It is part of the normal standalone L1 test inventory and therefore runs under the Node 22/24 required CI matrix.

This boundary only authorizes construction of local inactive release candidates on reviewed targets. It does not establish platform signing, notarization, immutable publication, external provenance attestation, website-download activation, public-mining readiness, public-testnet activation, or mainnet activation. Those gates remain independently fail-closed.
