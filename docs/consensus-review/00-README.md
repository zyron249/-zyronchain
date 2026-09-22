# Consensus 1.1 review package

Status of this package: **READY FOR INDEPENDENT REVIEW** is the highest label this repository may claim after the qualification tests in the pull request pass. This package is the author's review. It is not an independent review. Do not write "INDEPENDENT REVIEW PASSED".

Public testnet is not launched. Flags stay false. PR #904 stays draft until a human marks it ready for review.

## Read in order

| File | Contents |
|---|---|
| `01-ARCHITECTURE.md` | Frozen prepare/commit machine |
| `02-INVARIANTS.md` | S1–S10 and the code that enforces each |
| `03-LIVENESS-BOUND.md` | Why `X = f + 1` and what it does not prove |
| `04-THREAT-MODEL.md` | Faults assumed, and faults not modeled |
| `05-WIRE-AND-DISK.md` | Consensus 1.1.0 vs chain v1/v5 vs journal bytes |
| `06-MIXED-VERSION.md` | 1.0 rejected; no partial join |
| `07-QUALIFICATION-EVIDENCE.md` | What was executed, and what was not |
| `08-INTEGRATION-903.md` | Why #904 already contains #903 |
| `09-ECONOMICS-AND-FLAGS.md` | Constants that must not move |
| `10-LIMITATIONS.md` | Honest gaps |
| `11-REVIEW-CHECKLIST.md` | Independent reviewer checklist and commands |

Also read `docs/CONSENSUS_1_1_CHANGELOG.md` and `docs/CONSENSUS_1_1_UPGRADE_RUNBOOK.md`.

## Frozen design

Approach A (prepare then commit) with the higher-round unlock from approach E. Quorum stays `floor(2N/3)+1`. Do not redesign unless a later review finds a concrete safety bug.
