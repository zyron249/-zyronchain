# Miner custody session-open binding

POSIX miner candidate materialization must bind the native custody session to the exact `miner-release` directory identity that the JavaScript materializer approved before the helper starts.

The materializer snapshots the canonical release root device/inode. Production native-session startup receives that expected identity. After the helper opens the root with `O_NOFOLLOW` and verifies it is a directory, but before it emits `READY` or accepts any mutating command, it compares the opened descriptor's device/inode against the expected values. A mismatch or malformed expected identity fails closed before candidate mutation.

This closes the pre-session pathname replacement window left by completion-only binding. The existing descriptor-relative `openat`/`mkdirat` custody, `O_NOFOLLOW`/`O_EXCL`, stable source snapshots, file/directory `fsync`, and post-session pathname identity check remain required and unchanged.

Regression coverage compiles the production helper and supplies a deliberately incorrect expected inode. The helper must exit with the custody-identity failure before printing `READY`, proving that no session mutation protocol can begin on a replacement root.

This is local release-candidate custody evidence only. It does not activate public mining, public testnet, or mainnet, and it does not satisfy external signing, independent audit, protected-release-policy, or production HSM/remote-signer custody gates.
