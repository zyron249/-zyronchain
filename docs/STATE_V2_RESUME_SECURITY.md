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

## Transfer bounds (peer-supplied data)

- The manifest tip is compared with the operator's anchor (tip hash, header hash, height, state root) before the tip block is fully validated, so a forged tip costs one hash, not one signature check per transaction.
- Each chunk's records and key preimages are validated when the chunk arrives (F-09(b)).
- One attempt against one peer stops after `MAX_STATE_SYNC_TOTAL_BYTES` (4 GiB) of responses or `MAX_STATE_SYNC_DURATION_MS` (6 hours), whichever comes first. A spent budget is not retried against the same peer; the multi-peer fetch moves on to the next peer. An honest transfer at the protocol maxima (2,000,000 records, 1,000,000 key preimages) stays well below both. A frame whose declared length would not fit in the remaining budget is refused before its body is buffered.
- The byte budget counts every response body byte as it arrives, including bytes of responses that fail to decode or validate and are retried; failed frames are not free (round-4 retest on #986).
- The deadline is enforced by a timer that interrupts an in-flight dial, stream open, write, read or close; no retry starts after it, and it is checked again after the final stream close and after the final anchored assembly before a transfer is reported as successful.
- Residual risk: within these bounds a peer can still serve a self-consistent tree that only fails the final anchored validation. Sync only from peers you selected, and keep state sync an operator-initiated action.

## Evidence

`l1/test/state-v2-resume-security.test.ts` covers exact-boundary reads, initial oversize rejection, concurrent growth, path replacement and symlink rejection.

These controls do not authorize public mining, public testnet, mainnet, or production validator operation. External activation evidence remains mandatory.
