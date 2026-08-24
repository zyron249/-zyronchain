# Layer-1 local secret custody

Canonical local operator-secret reads use the descriptor-bound private-file boundary in `l1/src/local-security.ts`.

## Runtime invariant

Secret inputs that route through `readPrivateRegularFile()` are subject to the same fail-closed controls:

- the path must resolve to a regular file and must not be a symbolic link;
- on POSIX, the initial pre-open pathname device/inode identity is captured and the opened descriptor must match that exact identity before validation succeeds, so a parent/path replacement between the initial `lstat()` and descriptor open cannot silently substitute another same-user restrictive-permission secret;
- the canonical secret path is captured before descriptor open and must remain unchanged after open and again after the bounded read, so parent junction/reparse substitution is detected before secret bytes are returned on Windows as well as other platforms;
- the opened descriptor content snapshot is captured before reading and its device/inode, size, modification time and change time are revalidated after the bounded read, so same-inode mutation, truncation or growth fails closed before secret bytes are returned to a parser, decryptor, token consumer or signer;
- a ctime/link-count transition used by atomic hard-link publication is not accepted as byte-stability evidence by itself. When device/inode, size and mtime remain exact but ctime/link count changes, the reader performs a second bounded descriptor-positioned read, requires the descriptor metadata to remain exact across that revalidation, and requires the SHA-256 of the reread bytes to match the bytes about to be returned. This preserves legitimate first node-identity hard-link publication without allowing a concurrent same-inode content mutation to hide behind link-count metadata;
- on POSIX, the opened secret descriptor must be owned by the node process's effective UID; a privileged process does not accept a mode-restricted secret owned by another local account;
- on POSIX, group/other permission bits must be clear (`0600` recommended);
- on POSIX, the opened descriptor device/inode must still match the current path after validation;
- on POSIX, secret descriptors are opened with no-follow/non-blocking flags to reject symlink/FIFO substitution;
- the shared read is capped at **65,536 bytes (64 KiB)**;
- a file already larger than the cap is rejected from descriptor metadata before its full contents are allocated;
- after the descriptor is bound and its size is validated, the read buffer is sized to the captured byte size plus one overflow byte rather than the global ceiling, so small secrets do not incur ceiling-sized transient allocation;
- if the reader observes that overflow byte, an early EOF, a post-read descriptor snapshot change, or hard-link byte revalidation mismatch, concurrent growth/mutation fails closed before secret bytes are returned. The absolute 64 KiB ceiling remains authoritative.

This shared boundary covers canonical validator-key, keystore-password, operator authentication-token and persisted node-identity reads. Downstream formats may impose substantially tighter limits; the shared 64 KiB ceiling is an outer memory-safety bound, not a statement that every secret format may legitimately be that large.

These controls reduce local pre-open path-replacement, junction/reparse race, same-inode content-mutation, cross-account secret-custody, accidental-permission and oversized/repeated-read denial-of-service risk. They do not replace production HSM or independently audited remote-signer custody. Public-testnet and mainnet activation remain governed by the external evidence gates and must not be inferred from these local hardening controls.
