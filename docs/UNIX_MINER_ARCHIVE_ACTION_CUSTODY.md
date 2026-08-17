# Unix Miner Archive Action Custody

The Linux/macOS miner archive workflow is part of the miner release supply-chain boundary. Its checkout, Node setup and artifact-upload actions are pinned to reviewed immutable commit SHAs, and checkout credentials must not persist after source retrieval.

The focused policy verifier preserves the existing candidate-only security boundary: exact Node 22.23.2, locked dependency install and typecheck, runtime dependency audit, production SBOM, fail-closed inactive network profile, packaged launcher/runtime verification, exit-78 no-custody behavior, SHA-256 manifest generation, attestation, fail-on-missing artifact upload and 90-day evidence retention.

This hardening does not authorize publication. `publicMiningActivated`, `releaseEligible`, `platformSigningVerified` and `publicationAllowed` remain false for archive candidates. Immutable versioned release assets, platform signing/notarization where applicable, provenance/checksum review and explicit public-mining activation remain separate stop-ship gates.
