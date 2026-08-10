# Render four-validator memory soak

Status: **non-value-bearing private-testnet capacity evidence**. This does not authorize a public testnet or mainnet.

## Purpose

The live four-validator Render profile intentionally runs one gateway process and four canonical validator node processes inside one Render service. A free 512 MiB service showed an initial memory climb during warm-up before settling near the 300 MiB range. That observation was not enough to call the behavior either safe or a leak, so the repository now carries a repeatable process-level memory soak.

`l1/scripts/render-memory-soak.mjs` starts the real `render-private-testnet.mjs` launcher, waits for organic block finalization and samples Linux `/proc` memory for the launcher plus its four validator child processes. It records both RSS and PSS (Proportional Set Size) per process. RSS remains useful for identifying which process has grown, but summing RSS across five related Node processes double-counts shared native/library pages. The capacity gate therefore uses summed PSS, which apportions shared pages among the processes and is the appropriate process-level comparison to service memory/headroom.

The test correlates memory samples with the minimum finalized height and fails if validators die, convergence is lost, public launch flags change, internal validator RPC addresses leak, the configured PSS headroom is exceeded, or post-warm-up PSS growth exceeds its budget.

## Default CI budgets

The dedicated `Standalone L1 Render Memory Soak CI` uses:

- Node.js 24;
- warm-up through finalized height 2;
- target height 6 for pull requests;
- target height 10 on `main` pushes;
- target height 12 for manual workflow runs;
- 5-second process memory sampling;
- summed process-PSS ceiling of 440 MiB;
- maximum post-warm-up PSS growth budget of 96 MiB;
- summed RSS retained in the evidence as a conservative diagnostic only.

The 440 MiB PSS ceiling intentionally leaves headroom below a nominal 512 MiB service limit. Render's own cgroup/service memory metric remains the deployment source of truth; PSS provides a repeatable CI-side process attribution signal that does not multiply-count shared pages the way summed RSS does.

## Evidence interpretation

A green run means the exact tested commit kept the four validator processes alive, converged through the target height and remained within the configured proportional-memory budgets for that rehearsal window. It does **not** prove multi-day stability, release-hardware State-v2 capacity, production HSM behavior, multi-region reliability or Internet-scale adversarial load.

Live Render service metrics should still be retained alongside this CI evidence. If either the CI PSS soak or live service crosses the budget, release work must investigate component-level growth before raising limits. Do not hide a leak by simply purchasing a larger instance.
