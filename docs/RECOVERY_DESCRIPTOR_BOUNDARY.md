# Recovery descriptor boundary

ZyronChain recovery/control inputs are security-sensitive local files. A path-based reopen can race with symlink, FIFO, device, or other special-file substitution after an operator has selected the expected path.

## Required read boundary

For recovery files that use the descriptor-bound primitive:

- open once and read from the same descriptor;
- on POSIX, use no-follow and non-blocking open flags where supported;
- validate the opened object with `fstat` and require a regular file;
- reject symlinks and non-regular files fail-closed;
- apply byte limits only where the input has a documented bounded control-file contract. Large authenticated recovery checkpoints must not receive an arbitrary small cap.

These checks protect the local file boundary only. They do not replace chain identity, genesis, checkpoint tip-hash, snapshot-digest, State-v2 root, or finalized-history validation.

## Production recovery behavior

`loadRecoveryCheckpoint()` reads `recovery-checkpoint.json` through the descriptor-bound regular-file primitive. A substituted symlink or non-regular object is rejected before checkpoint contents can become a recovery optimization.

If finalized history is still complete, an unreadable, stale, corrupt, or inconsistent checkpoint only disables the checkpoint fast path and the node replays authoritative finalized history. If finalized history has been pruned, recovery still requires a valid compatible checkpoint and fails closed rather than silently accepting a weaker source.

Regression coverage verifies regular-file reads, non-regular/symlink rejection, production checkpoint substitution fallback, and corrupt-checkpoint full replay. No public-testnet, mainnet, mining, or launch-authorization gate is changed by this boundary hardening.
