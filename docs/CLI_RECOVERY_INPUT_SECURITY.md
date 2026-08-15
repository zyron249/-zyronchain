# CLI recovery input security boundary

Operator-supplied recovery inputs must be validated before they influence canonical chain recovery.

Genesis/control input is intentionally small and is capped at 256 KiB. On POSIX systems it is opened with no-follow/non-blocking semantics and must be a non-empty regular file before JSON/canonical genesis validation.

Trusted checkpoint snapshots can legitimately be much larger because they embed chain state. They therefore do not receive an arbitrary small byte cap, but the local read is bound to one regular-file descriptor and rejects POSIX symlink/FIFO/device substitution before parsing. The existing externally pinned tip hash and snapshot SHA-256 remain authoritative; descriptor binding does not weaken anchor verification.

These primitives are intended for `snapshot`, `checkpoint-install`, `checkpoint-fetch-install`, `state-fetch-install`, and `prune-finalized`. Production CLI wiring must use them before this hardening is considered complete. Public-testnet and mainnet activation gates are unaffected.
