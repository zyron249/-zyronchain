# Miner package source custody

## Status

Issue #781 is a release-integrity stop-ship discovered after POSIX destination materialization moved to descriptor-relative custody.

The current production package path remains quarantined. No public-mining, public-testnet, or mainnet readiness claim follows from this document or from the source-custody prototype.

## Threat boundary

Destination custody prevents candidate bytes from escaping the bound `miner-release` tree, but candidate integrity also requires source bytes to remain bound to reviewed source objects. A prior `realpath()` check followed later by an absolute `open()` does not provide that guarantee because attacker-replaceable parent path components are resolved again.

`native/miner-source-custody-posix.c` is the first bounded primitive for closing that gap on POSIX. It:

- opens the source root once with `O_DIRECTORY | O_NOFOLLOW` and retains the descriptor;
- resolves descendants with `openat()` relative to that retained root;
- rejects absolute paths, `.`/`..`, excessive path depth, non-regular final files, and final-component symlinks;
- rechecks the retained source-root device/inode identity before and after reading candidate bytes.

`test-miner-source-custody-posix.mjs` deterministically renames the bound source root, replaces the old pathname with an external symlink, and proves that the helper still reads the original source bytes rather than the attacker replacement. It also verifies traversal and final-symlink rejection.

## Remaining work before #781 can close

This foundation is not yet wired into `materialize-miner-package-posix.mjs`. Nested source-directory identity must be retained or otherwise proven against replacement by a different real directory, and generated launcher/README plus the runtime executable need explicitly bound/staged source custody. Miner Package and Miner Release Candidate CI must exercise the integrated path. Windows remains fail-closed under #761 until an audited handle-relative/reparse-safe implementation exists.

Do not remove or weaken `assertMinerPackagingCustodyReady()` while these requirements remain open.
