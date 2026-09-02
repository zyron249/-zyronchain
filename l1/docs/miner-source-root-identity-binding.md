# Miner source-root identity binding

POSIX miner package materialization treats every source pathname lookup as an untrusted boundary until the native custody helper has opened and verified the object that will actually be consumed.

Before each `SOURCE` command, the JavaScript materializer snapshots the canonical directory device and inode. The custody protocol carries that expected identity with the source pathname. The native helper opens the directory with `O_NOFOLLOW`, verifies that the resulting descriptor is a directory, then compares its `st_dev`/`st_ino` against the expected values before returning `OK SOURCE`. A mismatch, malformed identity, disappearing path, symlink/type substitution, or unsafe open failure terminates the session fail-closed before source bytes can be consumed.

Every nested `SOURCE_ENTER` transition is similarly bound to the JavaScript-observed child-directory device/inode. The helper opens the child relative to the already-retained parent descriptor with `openat(..., O_NOFOLLOW)`, verifies directory type and expected identity, and acknowledges only after that binding succeeds.

Every `COPYREL` regular-file copy is also bound to the JavaScript-observed source-file device/inode. The helper opens the file relative to the retained source-directory descriptor with `openat(..., O_NOFOLLOW)`, verifies that the opened object is a regular file and matches the expected identity, and rejects any mismatch before creating or writing the destination. The existing before/after regular-file snapshot remains in force during the read, so both pre-open pathname substitution and in-read mutation fail closed.

These controls apply to repository sources, packaged scripts and dependencies, the bundled Node runtime, and the private temporary directory that holds the generated launcher and README. Injected test helpers receive the same identity-bound session protocol and are not a supported downgrade path.

The change composes with the existing destination controls: session startup is bound to the expected `miner-release` device/inode, destination traversal uses descriptor-relative `openat`, destination creation is exclusive and `O_NOFOLLOW`, candidate bytes/directories are fsynced, and successful completion is re-bound to the final `miner-release` pathname identity.

This is local release-candidate supply-chain hardening only. It does not open public mining, public testnet, or mainnet activation gates, and it does not replace the independent external evidence tracked by the launch authorization issues.