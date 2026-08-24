# Layer-1 local secret custody

Canonical local operator-secret reads use the descriptor-bound private-file boundary in `l1/src/local-security.ts`.

## Runtime invariant

Secret inputs that route through `readPrivateRegularFile()` are subject to the same fail-closed controls:

- the path must resolve to a regular file and must not be a symbolic link;
- the canonical secret path is captured before descriptor open and must remain unchanged after open and again after the bounded read, so parent junction/reparse substitution is detected before secret bytes are returned on Windows as well as other platforms;
- the opened descriptor content snapshot is captured before reading and its device/inode, size, modification time and change time must remain unchanged after the bounded read, so same-inode mutation, truncation or growth fails closed before secret bytes are returned to a parser, decryptor, token consumer or signer;
- on POSIX, group/other permission bits must be clear (`0600` recommended);
- on POSIX, the opened descriptor device/inode must still match the path after validation;
- on POSIX, secret descriptors are opened with no-follow/non-blocking flags to reject symlink/FIFO substitution;
- the shared read is capped at **65,536 bytes (64 KiB)**;
- a file already larger than the cap is rejected from descriptor metadata before its full contents are allocated;
- the actual descriptor read allocates at most the cap plus one sentinel byte, so a file that grows after validation still fails closed instead of causing unbounded startup memory allocation.

This shared boundary covers canonical validator-key, keystore-password, operator authentication-token and persisted node-identity reads. Downstream formats may impose substantially tighter limits; the shared 64 KiB ceiling is an outer memory-safety bound, not a statement that every secret format may legitimately be that large.

These controls reduce local path-replacement, junction/reparse race, same-inode content-mutation, accidental-permission and oversized-file denial-of-service risk. They do not replace production HSM or independently audited remote-signer custody. Public-testnet and mainnet activation remain governed by the external evidence gates and must not be inferred from these local hardening controls.
