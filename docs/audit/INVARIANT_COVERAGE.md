# Invariant Coverage (Audit 2026-09-28)

Source of author S1–S10: `l1/src/round-view-change.ts` `SAFETY_INVARIANTS` and `docs/consensus-review/02-INVARIANTS.md`.  
Auditor mapping I1–I13 in `l1/test/audit-invariants.test.ts`.

| Id | Statement | Covered by tests | Status |
| --- | --- | --- | --- |
| S1 / I1 | Quorum `floor(2N/3)+1` | `consensus-safety-invariants`, `audit-invariants`, `audit-consensus-adversarial` | PASS |
| S2 / I2 | Finality = attestation quorum only | gate1, audit nil-VC test | PASS |
| S3 / I3 | One attest hash per height/round (journal) | `l1.test.ts` journal, properties | PASS |
| S4 | Prepare quorum before commit (except unique-hash) | split-vote, audit | PASS (unique-hash exception noted ZC-AUD-009) |
| S5 / I4 | Higher-round prepare to unlock conflict | safety invariants unit | PASS |
| S6 / I5 | Double commit needs honest double-sign | `exploreBoundedConsensus` N=3,4,7 | PASS (model-bounded) |
| S7 / I6 | VC intersects honest committers | bounded search + lock cert | PASS (model-bounded) |
| S8 / I7 | Locked VC cannot open new round | gate1 / block validateRoundCertificate | PASS |
| S9 | Timeout/VC never finalize | gate1 + audit | PASS |
| S10 | Journal/lock durable before sig | journal durability tests; ZC-AUD-001 fixed skip path | PASS after fix |
| I8 | chainId binds messages | audit forged/cross-chain prepares | PASS |
| I9 | 50M ZYN historical cap | `supply-invariant`, `audit-supply-economics` | PASS |
| I10 | Mining tracker reserved | chain genesis + hardened `fromGenesis` | PASS after fix |
| I11 | Domain separation v3 / tx v2 | audit domain test, remote signer tests | PASS |
| I12 | Safe integers | codec + amount checks + fee-sum fix | PASS after fix |
| I13 | Non-loopback RPC auth+proxy | `audit-rpc-classification` | PASS (CLI path) |

## Gaps

- Bounded search ≠ full TLA+/model check for all N and all schedules.
- Unique-hash completion without lock-cert durability (ZC-AUD-009) not integration-tested in this pass.
- Programmatic `createRpcServer` unauthenticated consensus (ZC-AUD-008) not fail-closed at library layer.
