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

## Current production status

The reusable descriptor-bound primitive and direct substitution regressions are present on the #367 hardening branch. Production `loadRecoveryCheckpoint()` is not yet wired to the primitive. Until that call site is converted and its stale/corrupt-checkpoint fallback semantics are regression-tested, issue #367 remains open and the branch must not be treated as recovery-hardening completion.

Finalized block history remains authoritative. A rejected or inconsistent local checkpoint may disable the fast path where full replay is still available; it must not create a weaker trust source.
