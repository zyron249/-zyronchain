# Render four-validator memory soak

Status: **non-value-bearing private-testnet capacity evidence**. This does not authorize a public testnet or mainnet.

## Purpose

The live four-validator Render profile intentionally runs one gateway process and four canonical validator node processes inside one Render service. A free 512 MiB service showed an initial memory climb during warm-up before settling near the 300 MiB range. That observation was not enough to call the behavior either safe or a leak, so the repository now carries a repeatable process-level memory soak.

`l1/scripts/render-memory-soak.mjs` starts the real `render-private-testnet.mjs` launcher, waits for organic block finalization and samples Linux `/proc` RSS for the launcher plus its four validator child processes. The test correlates memory samples with the minimum finalized height and fails if validators die, convergence is lost, public launch flags change, internal validator RPC addresses leak, the configured RSS headroom is exceeded, or post-warm-up growth exceeds its budget.

## Default CI budgets

The dedicated `Standalone L1 Render Memory Soak CI` uses:

- Node.js 24;
- warm-up through finalized height 2;
- target height 6 for pull requests;
- target height 10 on `main` pushes;
- target height 12 for manual workflow runs;
- 5-second RSS sampling;
- conservative summed process-RSS ceiling of 440 MiB;
- maximum post-warm-up growth budget of 96 MiB.

The 440 MiB ceiling intentionally leaves headroom below a nominal 512 MiB service limit. Summed RSS is conservative and can double-count shared pages, so it is a regression signal rather than an exact substitute for Render cgroup/service memory metrics.

## Evidence interpretation

A green run means the exact tested commit kept the four validator processes alive, converged through the target height and remained within the configured process-memory budgets for that rehearsal window. It does **not** prove multi-day stability, release-hardware State-v2 capacity, production HSM behavior, multi-region reliability or Internet-scale adversarial load.

Live Render service metrics should still be retained alongside this CI evidence. If either the CI soak or live service crosses the budget, release work must investigate the component-level growth before raising limits. Do not hide a leak by simply purchasing a larger instance.
