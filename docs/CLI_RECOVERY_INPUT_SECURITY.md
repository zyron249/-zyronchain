# CLI recovery input security boundary

Operator-supplied recovery inputs must be validated before they influence canonical chain recovery.

Genesis/control input is intentionally small and is capped at 256 KiB. On POSIX systems it is opened with no-follow/non-blocking semantics and must be a non-empty regular file before JSON/canonical genesis validation.

Trusted local checkpoint snapshots can legitimately be much larger, but the canonical P2P checkpoint format already caps a full snapshot at 64 MiB. The published local `checkpoint-install` path now uses that same 64 MiB ceiling instead of an unbounded descriptor read. The snapshot path is frozen canonically before open, direct symbolic links and non-regular inputs are rejected, POSIX uses `O_NOFOLLOW | O_NONBLOCK`, concurrent growth beyond the cap fails closed, and the canonical pathname is revalidated after open/read before bytes are returned to a parser. On Windows the post-open/post-read canonical check is the fail-closed boundary against parent junction/reparse substitution.

The existing externally pinned tip hash and snapshot SHA-256 remain authoritative. The size/path custody boundary does not weaken digest, finalized-history, governance-schedule or State-v2 root validation. A local full snapshot larger than the canonical 64 MiB checkpoint transport ceiling is rejected rather than creating an alternate, less-bounded recovery path.

The published `zyron-l1` binary enters through `secure-cli`. For `snapshot`, `checkpoint-install`, `checkpoint-fetch-install`, `state-fetch-install`, `prune-finalized`, and normal `node --genesis` startup, the wrapper reads operator paths through the hardened readers and stages immutable-by-path private copies in a mode-0700 temporary directory before the existing CLI parses them. `checkpoint-install` stages both genesis and the local checkpoint snapshot. The temporary files are mode 0600 and are removed when the process exits.

This removes the production binary's unchecked reopen of operator-controlled recovery paths without changing canonical genesis validation, trusted checkpoint tip/digest verification, finalized-history authority, or any mining/testnet/mainnet activation gate. Direct internal execution of `dist/src/cli.js` is not the supported production entrypoint; packaging and regression tests must keep the `zyron-l1` bin mapped to `dist/src/secure-cli.js`.

This control is recovery integrity/availability hardening only. It does not replace target-hardware peak-memory/recovery evidence tracked by #383, independent public-testnet evidence, or any mainnet activation requirement.
