# Remote signer: protocol v6 journal rules at the custody boundary (P0-09)

Status: reference implementation (`l1/src/remote-signer-service.ts`) and tests. **Validator signing/custody change: requires explicit owner approval before merge.** It is not an HSM, not an audited production signer and not evidence of production custody (P5-08).

## Why

A validator node already enforces the v6 anti-equivocation journal (F-01 design §6 and §9) before it asks a signer for a signature. When the key lives in a remote signer, a compromised or buggy node could still ask for a conflicting signature. Until this change the client refused v6 intents by default (`allowConsensusV6Intents`), because no signer enforced the v6 rules itself.

## What the reference signer enforces

The signer owns the key and its **own** durable signing journal. It uses the same journal v2 format and code (`SigningJournal`) as the node, including its single-writer lease. Every rule is checked and the row is fsynced **before** a signature is released:

| Intent | Rule at the signer |
|---|---|
| any v6 intent | refused unless `allowConsensusV6Intents: true`; enabling it requires the validator set (address + public key), and this key must be a member; payload `chainId` must equal the configured chain |
| `prepare-vote` `{chainId, height, round, blockHash}` + `context.justify` | one block per (H, r), with idempotent re-sign; no vote after a timeout at r' >= r or a vote at a higher round; SAFE-VOTE against the signer's own lock. The lock is released only by a PrepareQC(H, jr, B) that the **signer verifies** (quorum of distinct configured validators, prepare-vote domain), with lock.round < jr < r. A node-supplied justify round on its own is never trusted |
| `commit-vote` + `context.qc` | requires a verified PrepareQC for exactly (H, r, B); refused if its own prepare at (H, r) differs, if the round is closed, or if the lock would move backwards; lock + commit rows are one fsynced append |
| `round-timeout` + `context.highQC` | one payload per (H, r), with an identical payload re-signing identically; `-1 <= highQCRound <= r`; a reported highQC must be a verified QC that matches the payload; a new timeout is refused once a later round was voted or timed out; after it, nothing more in rounds <= r |
| `consensus-proposal` + `context.justify` | only the round leader (`expectedValidator`, configured set); one proposal per (H, r); unjustified (`justifyRound = -1`) only for the signer's own fresh block of that round; justified only with a verified QC for that block at `justifyRound` |
| `block-proposal` (header version 6) | only the round leader, with `header.proposer` equal to this validator; one fresh block per (H, r) |
| legacy intents (v1-v5) | unchanged signing; refused at a height that has v6 rows (§6.2-7); round skips are journaled. Legacy attestations and proposals carry no round in their payload, so the node journal remains their guard, as before |

`context` is evidence only. It is never part of the signed payload. The node sends it for v6 intents (`signWithValidator(..., context)`), and the client adds it to the version-2 request body only when present, so legacy requests are byte-identical to before.

HTTP front end (`startReferenceRemoteSignerServer`): POST JSON, mandatory bearer token compared in constant time, 256 KiB body limit, `{signature}` on success, 401 for bad credentials, 400 for malformed requests, and 409 when the signer refuses. The refusal reason is not returned, and payloads and tokens are never logged. Bind it to loopback or put it behind TLS, as the client requires.

## Tests

- `l1/test/remote-signer-v6.test.ts`: v6 refused by default; configuration checks; chain, domain and shape refusals; double prepare, double commit and commit-after-other-prepare, each refused also after a restart; lock released only by a verified higher-round QC for the same block (forged, under-quorum, same-round and other-block QCs refused); timeout ordering, payload pinning and highQC verification; leader-only proposals and one fresh block per round; no legacy/v6 mixing at a height; single-writer journal; HTTP authentication and 409 on conflicts.
- `l1/test/remote-signer-v6-node.test.ts`: four v6 validators whose keys live only in reference signers finalize three heights. In a partial-commit schedule, the locked validator's signer restarts, refuses double prepare, double commit (even with a genuine QC for another block), an unjustified lock violation and a forged justify from a compromised node, and the locked block then finalizes after a leader crash.

## Residual risks and operator rules

- The validator set is static configuration. After an on-chain validator-set change the operator must update it and restart the signer. A stale set fails closed for unknown signers, but if the set **grows**, a QC from the old, smaller set could satisfy the stale quorum. Treat a validator-set change as a signer maintenance step.
- The signer trusts its own clock for nothing. Round timing (`timeoutAllowedAt`) stays a node responsibility. A compromised node can make the signer time out early, which costs liveness, not safety.
- Restoring the signer's data directory from an older backup loses rows and can permit a double-sign, as for the node journal. Never restore a signer journal from a snapshot or VM image (see `V6_SAFETY_PROOF_OBLIGATIONS.md`).
- This is a reference implementation for rehearsal and for operators who build their own signer. Production custody (HSM or an audited signer, cross-host rotation) remains P5-08.
