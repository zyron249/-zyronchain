# Miner source-root identity binding

POSIX miner package materialization treats every source-root pathname as an untrusted lookup boundary until the native custody helper has opened and verified it.

Before each `SOURCE` command, the JavaScript materializer snapshots the canonical directory device and inode. The custody protocol carries that expected identity with the source pathname. The native helper opens the directory with `O_NOFOLLOW`, verifies that the resulting descriptor is a directory, then compares its `st_dev`/`st_ino` against the expected values before returning `OK SOURCE`. A mismatch, malformed identity, disappearing path, symlink/type substitution, or unsafe open failure terminates the session fail-closed before `SOURCE_ENTER` or `COPYREL` can consume bytes from that source root.

This applies to the repository source root, the bundled Node runtime directory, and the private temporary directory that holds the generated launcher and README. Injected test helpers receive the same identity-bound `SOURCE` protocol and are not a supported downgrade path.

The change composes with the existing retained-descriptor controls: destination session startup is bound to the expected `miner-release` device/inode, child traversal and copy use descriptor-relative `openat`, source and destination opens use `O_NOFOLLOW`, destination creation is exclusive, source regular-file snapshots are checked before and after reads, candidate bytes/directories are fsynced, and successful completion is re-bound to the final `miner-release` pathname identity.

This is local release-candidate supply-chain hardening only. It does not open public mining, public testnet, or mainnet activation gates, and it does not replace the independent external evidence tracked by the launch authorization issues.