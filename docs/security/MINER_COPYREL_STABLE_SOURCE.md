# Miner COPYREL stable-source boundary

The POSIX miner package materializer treats every retained `COPYREL` source as one immutable release-candidate snapshot.

The native custody helper opens the source through its retained directory descriptor with `O_NOFOLLOW`, captures device/inode/size plus nanosecond mtime/ctime from that opened descriptor, copies bytes from that same descriptor, and then `fstat`s it again. If identity, size, modification time, or change time moved during the read, candidate construction fails closed.

This prevents an in-place source mutation from silently producing mixed or unstable candidate bytes after the source descriptor has already been accepted. Existing descriptor-relative destination custody, no-follow source handling, exclusive destination creation, and canonical materialization boundaries remain unchanged.

Regression coverage mutates a large retained source while `COPYREL` is active and requires the helper to refuse the copy at the stable-source snapshot boundary.

This is local release-candidate integrity hardening only. It does not authorize signing, publication, public mining, public testnet, or mainnet activation, and it does not weaken any existing activation or release-promotion gate.
