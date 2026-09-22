# Wire and disk

Three version numbers are different and must not be collapsed.

| Name | Value on the public-testnet candidate | Meaning |
|---|---|---|
| Consensus wire | `/zyronchain/consensus/1.1.0` | libp2p protocol id for prepare, commit, view-change, skip |
| Chain protocol | genesis `initialProtocolVersion` 1 | Block header `version`. Signature encoding for version `< 3` embeds the domain in the payload |
| Mining protocol | 5, activation delay 100 | Proof-of-work claims. Signatures at version `>= 3` use `signCanonicalDomain` |

Chain genesis version 1 plus consensus wire 1.1 is the intended pair. The qualification test finalizes one block over `/zyronchain/consensus/1.1.0` and checks `header.version === 1`. Mining v5 is not activated by that test. A separate unit check shows a protocol-5 prepare signature verifies at version 5 and fails at version 1, and the reverse.

## Disk

- Block log `STORE_VERSION` remains 1.
- Journal kinds added: `prepare`, `view`. Slots `height:round#prepare` and `height:round#view`. Attest and skip remain on `height:round`.
- Lock quorum file: `lock-certificates/<height>-<round>.json`, fsynced before the commit signature is returned.
- Write-before-send order for a commit: lock file fsync, journal `reserveAttestation` fsync, then signature. A crash after the lock file and before the journal leaves an orphan file, which is not a lock. A crash after the journal and before the signature leaves a commit; nil view-change is refused.
- Prepare order: `reservePrepare` fsync, then signature.
- No migration tool. Rollback only before any 1.1 journal line or lock file exists.
- Recovery checkpoints and chain snapshots are the pre-existing block-log mechanism. They were not given a new consensus version field. A checkpoint of a 1.1 chain is readable by 1.1. It is not a promise that a 1.0 binary can apply a block whose round certificate contains view-change votes.

## Fresh node

`acceptFinalizedBlock` is the sync path. Partition tests use it to deliver the single finalized hash to a lagged process. A fresh node that dials with protocol 1.0 does not receive a round. A fresh 1.1 node accepts a block only when `validateAttestationQuorum` passes.
