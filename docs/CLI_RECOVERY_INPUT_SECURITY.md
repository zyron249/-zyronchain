# CLI recovery input security boundary

Operator-supplied recovery inputs must be validated before they influence canonical chain recovery.

Genesis/control input is intentionally small and is capped at 256 KiB. On POSIX systems it is opened with no-follow/non-blocking semantics and must be a non-empty regular file before JSON/canonical genesis validation.

Trusted checkpoint snapshots can legitimately be much larger because they embed chain state. They therefore do not receive an arbitrary small byte cap, but the local read is bound to one regular-file descriptor and rejects POSIX symlink/FIFO/device substitution before parsing. The existing externally pinned tip hash and snapshot SHA-256 remain authoritative; descriptor binding does not weaken anchor verification.

The published `zyron-l1` binary now enters through `secure-cli`. For `snapshot`, `checkpoint-install`, `checkpoint-fetch-install`, `state-fetch-install`, `prune-finalized`, and normal `node --genesis` startup, the wrapper reads operator paths through the hardened readers and stages immutable-by-path private copies in a mode-0700 temporary directory before the existing CLI parses them. `checkpoint-install` stages both genesis and the local checkpoint snapshot. The temporary files are mode 0600 and are removed when the process exits.

This removes the production binary's unchecked reopen of operator-controlled recovery paths without changing canonical genesis validation, trusted checkpoint tip/digest verification, finalized-history authority, or any mining/testnet/mainnet activation gate. Direct internal execution of `dist/src/cli.js` is not the supported production entrypoint; packaging and regression tests must keep the `zyron-l1` bin mapped to `dist/src/secure-cli.js`.
