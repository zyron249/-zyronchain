# Qualification evidence

Commands are from `l1/` after `npm run build`. Record only runs that were actually executed for the commit that contains this file. Timings below are filled from that run; if a row says NOT RUN, it was not executed.

## Executed by this qualification, when the test file passes

| Case | Where | What it is |
|---|---|---|
| N=4 2+2 halt then one later hash | `round-double-hash-liveness-regression.test.ts` | In-process `NodeService` |
| N=7 3+3+1 halt then one later hash | same file | In-process `NodeService`. Not multiprocess |
| N=4 and N=7 partition then heal | same file | In-process |
| Crash, lock file removed, nil refused, known prepares restore, original hash finalizes | same file | In-process journal |
| N=4 OS processes, separate key, directory, port | same file | Real processes |
| N=7 OS processes, separate key, directory, port, 3+3+1 | `consensus-1-1-qualification.test.ts` | Real processes |
| S1–S10 strings, quorum, bounded search | `consensus-safety-invariants.test.ts` | Model, not packets |
| Unique-hash completion still finalizes the original hash | `split-vote-liveness.test.ts` | In-process |
| S9 view-change is not finality | qualification file | Direct certificate calls |
| Protocol 5 vs 1 prepare signatures | qualification file | Unit |
| Malformed `/round/view` | qualification file | HTTP 400, height stays 0 |
| 1.0 dial rejected, 1.1 still finalizes header version 1 | qualification file | Two libp2p nodes |

## Not the same as multiprocess

The in-process N=7 tests share one OS process and call methods directly or over HTTP to in-process servers. Only the OS-process tests are multiprocess evidence.

## Not run

- A packet chaos scheduler for delay, loss, duplication, and reorder. Safety under those faults is not claimed beyond the partition matrix and the libp2p/HTTP tests that exist.
- A 101-block `NodeService` prepare/commit rehearsal of mining protocol 5. The existing rehearsal in `public-testnet-readiness.test.ts` uses `ZyronChain.produceBlock` / `attestBlock` / `acceptBlock` with delay 100. Re-run that test when claiming it. It does not drive the new collector.
- A live upgrade of a running 1.0 quorum. The runbook describes it and was not executed.
- External alerting. No alert sink was added.
- Independent review by a second person. Not claimed.

## Network faults that do exist

The regression partition cases keep a single finalized hash or null while the partition holds, then one hash after sync. Reconnect is `acceptFinalizedBlock` of that hash. Liveness after the partition is that one height, not an open-ended scheduler.

## Measured on this tree before the qualification commit

Command:

```
node --test --test-timeout=180000 --test-reporter=spec \
  dist/test/round-double-hash-liveness-regression.test.js \
  dist/test/consensus-safety-invariants.test.js \
  dist/test/split-vote-liveness.test.js \
  dist/test/consensus-1-1-qualification.test.js
```

Result: 18 pass, 0 fail, duration 5752 ms.

| Test | Duration |
|---|---|
| S9 view-change is not finality | 40 ms |
| Protocol v5 prepare signatures | 7 ms |
| Malformed `/round/view` | 95 ms |
| 1.0 protocol selection rejected, then 1.1 finalizes | 814 ms |
| N=7 OS processes, 3+3+1 | 1064 ms |
| S1–S10 and bounded search | 106 ms |
| N=4 in-process 2+2 then one hash | 652 ms |
| N=7 in-process 3+3+1 then one hash | 1132 ms |
| Partition heal N=4 and N=7 | 2779 ms |
| Crash, lost lock file, nil refused | 448 ms |
| N=4 OS processes, 2+2 | 615 ms |
| N=7 in-process unique completion and refusal | 2574 ms |

`npm test` on the tree that contains `consensus-extended-qualification.test.ts` finished with 680 pass, 0 fail, duration 59160.703602 ms. `npm run typecheck` completed before that run. `npm audit --audit-level=high` reported 0 vulnerabilities. Root `pytest -q` after installing `requirements.txt` reported 58 passed. The extended file alone, before that full suite, was 12 pass, 0 fail, duration 20180.889178 ms. See `12-EXTENDED-QUALIFICATION.md`.
