# Recovery descriptor boundary

ZyronChain recovery/control inputs are security-sensitive local files. A path-based reopen can race with symlink, FIFO, device, or other special-file substitution after an operator has selected the expected path.

## Required read boundary

For recovery files that use the descriptor-bound primitive:

- open once and read from the same descriptor;
- on POSIX, use no-follow and non-blocking open flags where supported;
- validate the opened object with `fstat` and require a regular file;
- reject symlinks and non-regular files fail-closed;
- apply byte limits only where the input has a documented bounded control-file contract. Large authenticated recovery checkpoints must not receive an arbitrary small cap;
- allocate read memory in proportion to the descriptor's validated file size rather than the configured maximum ceiling;
- reject any size change after the initial descriptor `stat()` instead of reallocating toward the ceiling while a local recovery/control file is changing;
- re-check the final descriptor size against the originally validated size immediately before returning bytes, so a shrink/growth race after the sentinel read still fails closed.

The proportional allocation rule matters for high-ceiling inputs such as local checkpoint snapshots: a tiny file under a 64 MiB ceiling must not reserve 64 MiB simply because that is the maximum accepted size. The final-size comparison closes the remaining same-file TOCTOU window after the sentinel read without weakening path, type, inode/device, or byte-ceiling checks. This is transient-memory/integrity hardening only; it is not target-hardware readiness evidence and does not close the State-v2 capacity gate tracked by #383.

These checks protect the local file boundary only. They do not replace chain identity, genesis, checkpoint tip-hash, snapshot-digest, State-v2 root, or finalized-history validation.

## Production recovery behavior

`loadRecoveryCheckpoint()` reads `recovery-checkpoint.json` through the descriptor-bound regular-file primitive. A substituted symlink or non-regular object is rejected before checkpoint contents can become a recovery optimization.

If finalized history is still complete, an unreadable, stale, corrupt, or inconsistent checkpoint only disables the checkpoint fast path and the node replays authoritative finalized history. If finalized history has been pruned, recovery still requires a valid compatible checkpoint and fails closed rather than silently accepting a weaker source.

Regression coverage verifies regular-file reads, non-regular/symlink rejection, production checkpoint substitution fallback, corrupt-checkpoint full replay, exact byte ceilings, proportional allocation under a very large ceiling, fail-closed growth during reading, and a deterministic size mutation after the sentinel read but before final descriptor validation. No public-testnet, mainnet, mining, or launch-authorization gate is changed by this boundary hardening.
