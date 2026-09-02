# Miner custody root pathname binding

POSIX miner candidate materialization retains the canonical `miner-release` directory through descriptor-relative custody, but release success must also remain bound to the pathname that downstream packaging and publication logic will consume.

Before the custody helper starts, the materializer records the canonical release root's directory device/inode identity. After the helper returns `OK END` and exits successfully, the materializer `lstat`s that same canonical pathname and requires it to remain a directory with the same device/inode identity. A disappeared path, symlink/non-directory replacement, or different inode fails closed with `miner release root pathname identity changed during materialization`.

This completion-boundary check complements the native helper's retained root descriptor, descriptor-relative `openat`/`mkdirat`, `O_NOFOLLOW`, exclusive child creation, source descriptor custody, stable source snapshots, and file/directory `fsync` behavior. It does not replace those controls and does not make pathname operations acceptable inside the native custody session.

Regression coverage uses a deliberately hostile helper fixture that follows the normal session protocol but replaces the release-root pathname immediately before acknowledging `END`. Materialization must reject that apparent success instead of returning a candidate path bound to the replacement inode.

Passing this boundary is local release-candidate custody evidence only. It does not activate public mining, public testnet, or mainnet, and it does not satisfy external signing, independent audit, protected-release-policy, or production custody gates.