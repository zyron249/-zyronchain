# Bounded local state-file custody

ZyronChain reads recovery/checkpoint and other non-secret local state files through a descriptor-bound bounded reader before bytes reach parsers.

The reader fail-closes unless the initial pathname is a regular non-symlink file and the opened descriptor retains the same device/inode identity that was observed before `open()`. The current pathname must continue to resolve to the same canonical path and the same descriptor identity after opening and after the bounded read. POSIX opens additionally use `O_NOFOLLOW` and `O_NONBLOCK`.

Memory remains bounded independently of this identity check: the configured hard byte ceiling is enforced from descriptor metadata, allocation is proportional to the validated descriptor size, and a one-byte sentinel read detects concurrent growth. Replacement, shrink/growth, symlink substitution, canonical-path drift or descriptor/path identity drift is rejected before bytes are returned to a parser.

This is local recovery/file-custody hardening only. It does not prove target-hardware recovery readiness, independent operator evidence, public-testnet activation or mainnet readiness, and it does not weaken any activation/finality gate.
