# Render clock fail-stop supervisor action custody

The Render clock supervisor workflow is regression evidence for validator fail-stop behavior under clock faults and same-data restart/resumed finality. It does not prove public-testnet or mainnet readiness by itself.

The workflow must use reviewed immutable GitHub Action SHAs, disable checkout credential persistence, run Node.js 24, install from the locked dependency graph, build the canonical L1, rehearse clock-fault detection, supervised launcher smoke, and same-data recovery, then archive commit/run-attempt-bound evidence for 90 days. Missing evidence fails closed.

`l1/scripts/verify-render-clock-supervisor-action-custody.mjs` and the dedicated policy CI reject action-reference drift, credential persistence, missing finality/fail-stop rehearsals, or weakened evidence retention. Consensus/finality semantics and all mining/public-testnet/mainnet activation gates remain unchanged.
