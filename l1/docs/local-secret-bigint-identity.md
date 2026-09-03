# Exact local-secret file identity

Local validator, recovery, and miner secret inputs are accepted only after the pathname and the opened regular-file descriptor are bound to the same filesystem identity.

Security-relevant `st_dev` and `st_ino` values are captured with BigInt-backed Node.js stat APIs. They are never coerced through JavaScript `Number` before identity comparison. This prevents distinct filesystem identities above the safe-integer range from aliasing through numeric rounding.

The exact-identity check is additive to the existing fail-closed custody controls. It does not relax canonical-path revalidation, POSIX `O_NOFOLLOW`/`O_NONBLOCK`, effective-UID ownership, restrictive mode checks, bounded descriptor reads, descriptor snapshot stability, hard-link byte revalidation, or secret-buffer zeroization.

Regression coverage includes adjacent identities above 2^53: the control demonstrates that `Number` collapses the pair while the production BigInt comparison rejects them as distinct.

This is local secret-custody hardening only. It does not establish public mining, public-testnet, or mainnet readiness, and it does not alter any activation gate.