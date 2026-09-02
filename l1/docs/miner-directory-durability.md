# Miner candidate directory durability boundary

The POSIX miner candidate custody helper treats namespace creation as successful only after the containing directory has been durably synchronized.

For `RESERVE`, the parent directory is `fsync`ed after `mkdirat`. For `WRITE` and `COPYREL`, the created file is fully written and `fsync`ed first, then closed, and the containing directory is `fsync`ed before the helper emits the corresponding success acknowledgement. Directory `fsync` errors remain fail-closed; the helper does not special-case unsupported filesystems to preserve CI portability.

This supplements, rather than replaces, the existing `O_NOFOLLOW`, exclusive destination creation, retained source-directory descriptors and stable `COPYREL` source-snapshot checks. It is local crash-consistency evidence for candidate materialization only. It does not sign or publish artifacts and does not open public-mining, public-testnet or mainnet activation gates.
