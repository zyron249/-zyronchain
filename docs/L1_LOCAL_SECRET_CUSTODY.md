# Layer-1 local secret custody

Canonical local operator-secret reads use the descriptor-bound private-file boundary in `l1/src/local-security.ts`.

## Runtime invariant

Secret inputs that route through `readPrivateRegularFile()` are subject to the same fail-closed controls:

- the path must resolve to a regular file and must not be a symbolic link;
- on every platform, the initial pre-open pathname device/inode identity is captured and the opened descriptor must match that exact identity before validation succeeds, so a same-path replacement between the initial `lstat()` and descriptor open cannot silently substitute another regular-file secret; POSIX ownership/permission rules remain POSIX-only;
- the canonical secret path is captured before descriptor open and must remain unchanged after open, after the bounded read, and again after any hard-link byte reread, so parent junction/reparse substitution is detected before secret bytes are returned on Windows as well as other platforms;
- on every platform, the opened descriptor device/inode must still match the current pathname identity after validation, so a later same-path file-object replacement is rejected independently of canonical-path equality;
- the opened descriptor content snapshot is captured before reading and its device/inode, size, modification time and change time are revalidated after the bounded read, so same-inode mutation, truncation or growth fails closed before secret bytes are returned to a parser, decryptor, token consumer or signer;
- a ctime/link-count transition used by atomic hard-link publication is not accepted as byte-stability evidence by itself. When device/inode, size and mtime remain exact but ctime/link count changes, the reader performs a second bounded descriptor-positioned read, requires the descriptor metadata to remain exact across that revalidation, requires the SHA-256 of the reread bytes to match the bytes about to be returned, and then revalidates the current path/canonical identity against the same opened descriptor. This preserves legitimate first node-identity hard-link publication without allowing the extended reread window to bypass pathname custody checks;
- on POSIX, the opened secret descriptor must be owned by the node process's effective UID; a privileged process does not accept a mode-restricted secret owned by another local account;
- on POSIX, group/other permission bits must be clear (`0600` recommended);
- on POSIX, secret descriptors are opened with no-follow/non-blocking flags to reject symlink/FIFO substitution;
- the shared read is capped at **65,536 bytes (64 KiB)**;
- a file already larger than the cap is rejected from descriptor metadata before its full contents are allocated;
- after the descriptor is bound and its size is validated, the read buffer is sized to the captured byte size plus one overflow byte rather than the global ceiling, so small secrets do not incur ceiling-sized transient allocation;
- if the reader observes that overflow byte, an early EOF, a post-read descriptor snapshot change, hard-link byte revalidation mismatch, or post-reread pathname/canonical identity drift, the read fails closed before secret bytes are returned. The absolute 64 KiB ceiling remains authoritative.

This shared boundary covers canonical validator-key, keystore-password, operator authentication-token and persisted node-identity reads. Downstream formats may impose substantially tighter limits; the shared 64 KiB ceiling is an outer memory-safety bound, not a statement that every secret format may legitimately be that large.

Plaintext validator-key files are additionally schema-bound: the top-level JSON object must contain exactly one field, `privateKey`. Unknown, typo, shadow or future-looking plaintext fields are rejected rather than ignored. Encrypted keystore files retain their own exact authenticated schema, so plaintext and encrypted validator-key custody both fail closed on ambiguous top-level structure.

These controls reduce local pre-open path-replacement, junction/reparse race, same-inode content-mutation, cross-account secret-custody, ambiguous key-schema, accidental-permission and oversized/repeated-read denial-of-service risk. They do not replace production HSM or independently audited remote-signer custody. Public-testnet and mainnet activation remain governed by the external evidence gates and must not be inferred from these local hardening controls.
