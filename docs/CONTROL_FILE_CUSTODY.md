# Control-file custody boundary

Small local control files are byte-bounded, non-empty regular files and are read through the same descriptor-bound pathname custody primitive used by other bounded local state inputs.

The reader freezes the canonical pathname before opening the file, validates the opened descriptor/path relationship, performs a bounded read, and revalidates the canonical pathname again before bytes are returned to a parser. On POSIX it additionally uses `O_NOFOLLOW | O_NONBLOCK` and device/inode checks. On Windows the post-open and post-read canonical revalidation protects against parent junction/reparse substitution even though POSIX no-follow semantics are unavailable.

This boundary is shared by security-relevant inputs including miner genesis, hardened CLI genesis staging, and chain/storage control metadata. Existing byte ceilings and downstream semantic checks remain authoritative.

This is local integrity/availability hardening only. It is not evidence of public mining, public-testnet, mainnet, target-hardware recovery capacity, or independent operator readiness, and it does not relax any activation, consensus/finality, key-custody, or release-publication gate.
