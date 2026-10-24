# L1 test reliability boundary

The canonical L1 test runner executes every compiled `*.test.js` file and applies a 10-minute per-test timeout on Node 22/24. The timeout is deliberately fail-closed: a hung regression must fail with a concrete test result before GitHub-hosted runners reach their six-hour job ceiling.

This timeout does not skip or filter security, consensus, finality, recovery, mining, custody, RPC, or P2P tests. It is a CI reliability control only and is not evidence of public-testnet, mainnet, mining, or deployment readiness.

If a legitimate regression needs more than ten minutes, the test should be decomposed or moved to a dedicated bounded evidence workflow rather than weakening the canonical timeout.

## Devnet CI jobs and the known protocol-v1 flake

| Job (check name) | Command | Protocol | Required check | Expected result |
|---|---|---|---|---|
| `local-devnet (protocol v1, informational, known F-01 flake)` | `npm run devnet:check` | v1 | no, informational | Known flake, about 50% pass (54/118 job attempts, 2026-10-13..16) |
| `local-devnet-v6` | `npm run devnet:check:v6` | v6 | no; candidate (owner setting) | Pass: 117/118 job attempts over 98 runs, 2026-10-13..16; the one failure was a genuine TypeScript build break on a dependency PR |

`local-devnet` runs the two-validator chain on protocol v1, which still has the legacy F-01 consensus split (see [`V6_SAFETY_PROOF_OBLIGATIONS.md`](V6_SAFETY_PROOF_OBLIGATIONS.md) and the F-01 entries in [`L1_OPERATIONS_RUNBOOK.md`](L1_OPERATIONS_RUNBOOK.md)). Whether a run passes depends on which validator starts its round timer first. A controlled A/B on the same CI image gave 13/27 passes before the F-01 fix and 12/27 after, which is no statistical difference: the F-01 change did not cause it, and only activating v6 removes it. The fix lives in protocol v6, which `local-devnet-v6` exercises.

The known flake fails with exactly one of these messages in `local-devnet`. The artifact operator rehearsal (`l1/scripts/artifact-operator-rehearsal.mjs`) runs its validators under protocol v6 and is no longer affected; any of these messages there is a real failure:

- `Timed out: transfer finalized by both validators`
- `Timed out: finality resumes after validator restart`
- `did not converge at height`

Rerun the failed job once and note it on the pull request. Any other failure message is a real regression and must be investigated.

The job's last step, `scripts/classify-devnet-v1-result.mjs`, runs after the devnet step whatever its result and only explains it; it never changes the job result. A failure counts as the known flake only when the whole v1 stall signature is present:
1. The harness timed out with one of the two `local-devnet` messages above, with no wrapped assertion. Only a connection error from a restarting peer is allowed.
2. `last-status` shows both validators at the same height H with the same tip.
3. Both validator logs show the protocol-v1 round-skip quorum failing at height H+1, and neither validator finalized a block above H.

That failure gets a warning annotation "Known protocol-v1 flake (F-01), not a regression". Any other failure gets an error annotation "NOT the known F-01 flake" and the classify step fails as well. This includes a timeout caused by a wrong balance or nonce, a chain that kept finalizing, diverged validators, or missing validator logs. A "success" without the devnet summary is treated the same way. A pass gets a notice that the job is informational. Each outcome is also written to the job summary, and on failure the step prints the last 200 lines of both validator logs so the stall can be analysed from the job log. Neither devnet job uses `continue-on-error`: a v1 failure stays visible as a failed informational job instead of being hidden. `l1/test/devnet-v1-informational-ci.test.ts` pins the classifier and these workflow properties.

Recommendation (P1-04): make `local-devnet-v6` a required check. That is a branch-protection setting the owner controls; this repository does not change it.

The test, its timeouts and the v1 harness startup order are deliberately unchanged: loosening them would hide the F-01 split instead of fixing it. The required checks are `l1` (Node 22 and 24), `dependency-audit`, `test` (Python 3.11 and 3.12) and `independent-light-client`. Neither devnet job is required. Interactive `npm run devnet` runs the same v1 path and may also need a restart.

Same-inode State-v2 cache mutation tests must change file size. Same-length writes can keep `size+mtimeMs+ctimeMs` identical on coarse-timestamp filesystems and produce a false pass.
## Real-socket tests that need a second loopback address

Some RPC identity and rate-limit regressions (`rpc-client-identity.test.ts`, `rpc-limits-lows.test.ts`) open real sockets from `127.0.0.2` to prove that a second loopback client, or a local proxy on another `127.0.0.0/8` address, is keyed separately. Linux and Windows route the whole `127.0.0.0/8` block to the loopback interface, so these tests need no setup there. macOS assigns only `127.0.0.1` to `lo0`, and binding `127.0.0.2` fails with `EADDRNOTAVAIL`. The macOS jobs in Miner Package CI and Miner Release Candidate CI therefore add the alias (`sudo ifconfig lo0 alias 127.0.0.2 up`) before the full L1 suite. Run the same command once before `npm test` on a local macOS machine. The tests are not skipped on any platform.
