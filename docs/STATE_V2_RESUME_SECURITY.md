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
- The manifest record and key-preimage counts are authenticated by the anchored state root (F-09(b), P1-08). Records are fetched root first and each must be the next node of the anchored tree, so a peer cannot serve more records than the anchored tree holds (an inflated count fails at the first chunk past the tree, a short count fails at the end of the records). Once the tree is complete, its leaves fix the key-preimage set: a key count that differs from the number of anchored leaves is rejected before any key is requested, and each key preimage must hash to a distinct anchored leaf key in the chunk that carries it. Key preimages staged by an earlier attempt are re-checked the same way and the staging is discarded on mismatch.
- One attempt against one peer stops after `MAX_STATE_SYNC_TOTAL_BYTES` (4 GiB) of responses or `MAX_STATE_SYNC_DURATION_MS` (6 hours), whichever comes first. A spent budget is not retried against the same peer; the multi-peer fetch moves on to the next peer. An honest transfer at the protocol maxima (2,000,000 records, 1,000,000 key preimages) stays well below both. A frame whose declared length would not fit in the remaining budget is refused before its body is buffered.
- The byte budget counts every response body byte as it arrives, including bytes of responses that fail to decode or validate and are retried; failed frames are not free (round-4 retest on #986).
- The deadline is enforced by a timer that interrupts an in-flight dial, stream open, write, read or close; no retry starts after it, and it is checked again after the final stream close and after the final anchored assembly before a transfer is reported as successful.
- Residual risk: a peer can still stall or disconnect, and it can waste at most one rejected chunk (or one malformed frame) beyond the genuine anchored data before it is dropped. Everything accepted is checked against the anchored state root as it arrives, and the final anchored validation and external snapshot digest still gate installation. Sync only from peers you selected, and keep state sync an operator-initiated action.

## Evidence

`l1/test/state-v2-resume-security.test.ts` covers exact-boundary reads, initial oversize rejection, concurrent growth, path replacement and symlink rejection. `l1/test/p1-08-authenticated-counts.test.ts` covers inflated, maximal and short manifest counts, uncommitted and duplicate key preimages, and poisoned staged key preimages.

These controls do not authorize public mining, public testnet, mainnet, or production validator operation. External activation evidence remains mandatory.
