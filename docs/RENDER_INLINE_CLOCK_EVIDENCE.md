# Render inline clock monitor evidence boundary

The inline clock monitor workflow is controlled CI evidence for the validator clock fail-closed path. It is not public-testnet or mainnet readiness evidence.

The workflow must use reviewed immutable GitHub Action SHAs, disable checkout credential persistence, run on Node.js 24 with locked dependencies, build the canonical L1, rehearse the inline clock monitor, and verify that the preload remains harmless for ordinary typecheck/build activity.

Evidence artifacts are commit- and run-attempt-bound, fail closed if missing, and retain for 90 days. Any drift in action pins, checkout credential custody, the clock rehearsal, preload safety check, or artifact boundary is rejected by `verify-render-inline-clock-action-custody.mjs`.

This hardening does not alter validator clock semantics, consensus/finality behavior, public mining, public-testnet activation, or mainnet activation gates.
