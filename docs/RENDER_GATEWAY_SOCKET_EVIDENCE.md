# Render gateway socket-abuse evidence boundary

The Render gateway socket red-team workflow is a controlled CI rehearsal for slow-header and oversized-header rejection. It is useful regression evidence for the public status-gateway HTTP boundary, but it is not real-Internet adversarial evidence and must not be used to claim public-testnet or mainnet readiness.

The workflow uses immutable reviewed GitHub Action SHAs, disables checkout credential persistence, installs locked L1 dependencies, builds the canonical L1, runs the socket-abuse rehearsal on Node 24, and archives commit/run-attempt-bound evidence with fail-on-missing behavior and 90-day retention.

The dedicated action-custody policy verifier fails review if action refs become mutable, checkout credentials are persisted, or the locked-install/build/rehearsal/evidence boundary drifts. Activation gates remain independent and fail closed.
