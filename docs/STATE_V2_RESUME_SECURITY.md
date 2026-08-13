# Portable State-v2 resume security boundaries

Status: **pre-public-testnet recovery hardening**

Portable State-v2 resume files are untrusted download staging, not authoritative chain state. A completed bundle still has to pass the external checkpoint anchor, finality and authenticated State-v2 validation before installation.

## Local staging invariants

- Manifest and chunk files are read from one opened file descriptor; validation is not performed on one path object and then followed by a separate path reopen.
- The opened object must be the same regular file identified by the path before descriptor binding, and the path must still identify that object after the bounded read.
- Symlink substitution and path replacement therefore fail closed rather than causing the resume logic to consume another local object.
- Each read uses a `maxBytes + 1` sentinel buffer. Files already above the configured cap are rejected before the bounded allocation, and files that grow beyond the cap after opening are rejected during the read.
- Existing manifest/chunk checksums, exact chunk ranges, chain/genesis/tip/snapshot identity and authenticated Merkle-state validation remain unchanged.
- Atomic staging publication continues to use an owner-only temporary file, file fsync, rename and parent-directory fsync.

## Evidence

`l1/test/state-v2-resume-security.test.ts` covers exact-boundary reads, initial oversize rejection, concurrent growth, path replacement and symlink rejection.

These controls do not authorize public mining, public testnet, mainnet, or production validator operation. External activation evidence remains mandatory.
