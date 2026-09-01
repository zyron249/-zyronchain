# Miner public-mining activation evidence binding

Public-mining activation evidence is a stop-ship authorization boundary, not a generic review artifact. A canonical `evidence/public-mining-activation.json` or `evidence/public-mining-authorization.json` path at the exact source commit is necessary but not sufficient for release promotion.

For any requested promotion, the gate derives the ordered Windows, macOS and Linux promoted artifact subjects from the canonical release URLs and `assetSha256` values. It serializes a version-1 canonical document containing the exact `releaseVersion`, lowercase 40-hex `sourceCommit`, and the three `{platform,name,sha256}` subjects, with a terminating newline. The terminal `#sha256=` digest on `publicMiningActivation` evidence must equal the SHA-256 of those exact bytes.

This prevents stale, generic, renamed, cross-platform-swapped, release-drifted, source-drifted or artifact-drifted activation evidence from authorizing another miner release. Missing or duplicate subjects, mutable evidence refs and digestless evidence fail closed.

This local verifier does not activate public mining and does not prove protocol-v5/public-mining readiness, public-testnet readiness or mainnet readiness. It grants no signing, OIDC, upload, publication or website activation authority. All existing launch and activation gates remain independently required.
