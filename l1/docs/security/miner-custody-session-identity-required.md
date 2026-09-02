# POSIX miner custody session identity requirement

The production POSIX miner custody entrypoint requires every `session` invocation to provide the expected release-root device and inode: `session <root> <expected-dev> <expected-ino>`.

Missing identity arguments are rejected with exit 64 before `READY` and before any mutation command can be accepted. Malformed identities are also rejected before `READY`. A well-formed identity that does not match the `O_NOFOLLOW`-opened release-root descriptor remains fail-closed with exit 70.

The existing descriptor-relative destination/source custody, source-root/SOURCE_ENTER/COPYREL identity checks, `O_NOFOLLOW`/`O_EXCL`, source stability snapshots, file/directory fsync barriers, release-root completion binding, and activation/publication gates are unchanged.

This change is local miner release-candidate custody hardening. It is not evidence that public mining, a public testnet, or mainnet is ready or activated.
