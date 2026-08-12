# Layer-1 local secret custody

Canonical local operator-secret reads use the descriptor-bound private-file boundary in `l1/src/local-security.ts`.

## Runtime invariant

Secret inputs that route through `readPrivateRegularFile()` are subject to the same fail-closed controls:

- the path must resolve to a regular file and must not be a symbolic link;
- on POSIX, group/other permission bits must be clear (`0600` recommended);
- on POSIX, the opened descriptor device/inode must still match the path after validation;
- the shared read is capped at **65,536 bytes (64 KiB)**;
- a file already larger than the cap is rejected from descriptor metadata before its full contents are allocated;
- the actual descriptor read allocates at most the cap plus one sentinel byte, so a file that grows after validation still fails closed instead of causing unbounded startup memory allocation.

This shared boundary covers canonical validator-key, keystore-password, operator authentication-token and persisted node-identity reads. Downstream formats may impose substantially tighter limits; the shared 64 KiB ceiling is an outer memory-safety bound, not a statement that every secret format may legitimately be that large.

These controls reduce local path-replacement, accidental-permission and oversized-file denial-of-service risk. They do not replace production HSM or independently audited remote-signer custody. Public-testnet and mainnet activation remain governed by the external evidence gates and must not be inferred from these local hardening controls.
