# Standalone L1 key-rotation action custody

The validator key-rotation rehearsal is security evidence, not an activation mechanism. Its GitHub Actions dependencies are pinned to reviewed immutable SHAs and checkout credential persistence is disabled so repository-controlled rehearsal code does not inherit a reusable GitHub token.

The policy verifier requires least-privilege `contents: read`, Node 24, locked dependency installation and build, the quorum-authorized validator-key-rotation rehearsal, archived commit-bound evidence, SHA-256 evidence checksums, `if-no-files-found: error`, and 90-day retention.

Changing these CI action/runtime custody controls does not change validator quorum rules, consensus or finality semantics, mining, public-testnet/mainnet activation, validator production custody, or any launch authorization gate. CI rehearsal evidence remains project-generated evidence and must not be presented as production HSM/remote-signer custody or independent operator evidence.
