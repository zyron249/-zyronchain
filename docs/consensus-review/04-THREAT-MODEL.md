# Threat model

## In scope

- Up to `f` Byzantine validators who may prepare or commit conflicting hashes outside the journal, withhold votes, or propose when it is their turn.
- Honest validators that follow the journal: one prepare per round, one commit per round, no skip after a prepare.
- Partitions that hide a subset, then heal. The regression matrix covers N=4 subsets of 2 and 3 and N=7 subsets of 4 and 5, in process. Safety during the partition is a single hash or null. After heal, one hash at that height.
- Crash after a commit journal entry. Restart must not nil-vote the lock away.
- Malformed RPC: wrong JSON, wrong keys, wrong types. Fail closed with HTTP 400 and no vote field.
- A peer that speaks only `/zyronchain/consensus/1.0.0`.

## Out of scope for this qualification

- More than `f` Byzantine validators. Quorum intersection does not hold.
- A delay, loss, duplication, and reorder chaos scheduler. Not implemented. Not claimed.
- Adaptive corruption that exceeds `f` between rounds.
- Key compromise of an honest validator's files. The journal cannot protect a stolen key.
- Governance that changes the validator set inside a view-change. Not implemented.
- Public RPC exposure of consensus routes. They stay classified as consensus.

## Fail-closed bounds that do exist

- HTTP body cap `MAX_BODY_BYTES` = 2_500_000, plus a JSON structural token cap.
- View-change `prepares.length > 100` rejected.
- P2P frame cap 2_500_000, rate 240/60s, inflight 2 per peer, outstanding 32, max inbound streams 4.
- Duplicate votes in a certificate rejected.
- Unknown validator keys rejected.

No new alert transport was added. Bounds are local rejects, not pages in an external monitor.
