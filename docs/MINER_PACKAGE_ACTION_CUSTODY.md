# Miner Package Action Custody

`Miner Package CI` is currently a **fail-closed packaging quarantine boundary**, not artifact-production or public-mining activation evidence.

Until #761 supplies true handle-relative filesystem custody, the workflow must not create a self-contained miner bundle, SBOM, checksum manifest, release candidate, or uploaded miner artifact. It still runs the supported Linux/macOS/Windows and Node 22/24 matrix, locked installation, typecheck, miner security checks, inactive-network-profile assertion, build, and platform-appropriate regressions. Its final custody assertion invokes `test-miner-packaging-quarantine.mjs`, which requires the packager to reject before `miner-release` exists.

The dedicated policy verifier pins checkout/setup-node actions to reviewed immutable commit SHAs, requires checkout credential persistence to remain disabled, requires the quarantine regression on every matrix job, and rejects reintroduction of package materialization, SBOM/prune, checksum publication, or artifact upload while the quarantine is active.

`Miner Release Candidate CI` follows the same containment rule: it may validate source/runtime/security behavior, but it must not materialize, attest, upload, or describe a miner release candidate until the handle-relative custody stop-ship is closed.

These controls do not solve #761, #757, #683, or #636. They prevent the known pathname-only materialization path from producing candidate bytes while those issues remain open. Public mining, website download publication, public-testnet activation, and mainnet activation remain separately fail-closed.
