# Linux and macOS miner distribution boundary

The Linux and macOS end-user candidates are built from the reviewed self-contained miner bundle as `ZyronMiner-linux-<arch>.tar.gz` and `ZyronMiner-macos-<arch>.tar.gz`. Each archive contains the bundled Node.js runtime, production dependencies, miner code, canonical network profile, documentation, `START-HERE.txt`, and the executable `ZyronMiner` launcher. A system Node.js, npm, or Git installation is not required by the packaged runtime.

Archive generation and extraction smoke tests run on the matching GitHub-hosted Linux/macOS runner. CI verifies that the launcher and bundled runtime remain executable and that the inactive canonical network profile exits with code 78 before creating or modifying custody.

These archives remain **candidate evidence only** while launch gates are closed. Metadata must retain `publicMiningActivated=false`, `releaseEligible=false`, `platformSigningVerified=false`, and `publicationAllowed=false`. A successful archive job proves packaging mechanics, bounded startup behavior, dependency audit/SBOM generation, and candidate provenance; it does not authorize public distribution, public mining, public testnet, or mainnet.

Promotion still requires immutable versioned GitHub Release assets whose checksums/provenance match reviewed source plus the required platform signing/notarization evidence. macOS notarization/signing and any Linux signing policy remain separate release-governance gates. The website download control must remain fail-closed until those release requirements and the explicit public-mining activation gate are satisfied.
