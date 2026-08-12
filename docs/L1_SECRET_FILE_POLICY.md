# ZyronChain L1 operator secret-file policy

Status: **pre-mainnet security invariant**. This document does not authorize public-testnet or mainnet activation.

Validator keys, encrypted-keystore password files, peer authentication tokens, remote-validator-signer bearer tokens, and key-generation password inputs are local secrets. Canonical L1 operator workflows require these inputs to be real regular files rather than symbolic links. On POSIX systems they must not expose group/other permission bits (`0600` is recommended).

Secret content is read through the descriptor-bound private-file reader. The implementation opens the file first, validates the opened descriptor, rejects a symbolic-link path, verifies owner-only POSIX permissions, and checks that the descriptor device/inode still matches the path before reading from that same descriptor. A path replacement during validation therefore fails closed instead of causing the process to consume the replacement secret.

The canonical CLI preflight performs the same high-level path policy before command execution, but runtime consumers must not rely on preflight alone: validator key/password, peer token, remote-signer token, miner keystore/password, and keygen password reads use the descriptor-bound reader directly.

Operators must keep secrets outside repositories, images and command-line values; provision them through the reviewed host/signer secret-management process. Remote validator signing remains preferred for production-class custody and still requires an independently audited signer/HSM, rotation/recovery evidence and the external activation gates tracked in `STANDALONE_L1_READINESS.md`.
