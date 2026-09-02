# Miner source child identity binding

POSIX miner release-candidate materialization now binds every retained `SOURCE_ENTER` transition to the directory identity observed by the JavaScript materializer.

For each child directory, the materializer snapshots `st_dev` and `st_ino` with `lstat()` and sends both values with the child component. The native custody helper opens that component relative to the already-retained parent descriptor using `openat(..., O_NOFOLLOW)`, verifies that the opened descriptor is a directory, and then compares its device/inode pair with the expected identity before returning `OK SOURCE_ENTER`.

If the pathname disappears, becomes a symlink or non-directory, or resolves to a different inode before the native open, the session fails closed and the child descriptor is never admitted to the retained source stack. This closes the remaining substitution window between path-level enumeration and descriptor-retained subtree traversal.

This change does not weaken the existing destination-root binding, source-root binding, exclusive destination creation, regular-file stable-snapshot checks, fsync durability requirements, or mining activation/publication gates.

This is local miner package supply-chain hardening only. It is not evidence that public mining, a public testnet, or mainnet is ready or activated.
