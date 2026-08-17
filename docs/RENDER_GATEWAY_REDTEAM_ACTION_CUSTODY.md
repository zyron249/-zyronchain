# Render gateway red-team action custody

The Render gateway red-team workflow is security evidence, not an activation claim. It runs a controlled large-burst rehearsal against the public status-gateway boundary and archives commit-bound evidence for RPC/DoS review.

Supply-chain and custody invariants are fail-closed:

- checkout, setup-node and upload-artifact use reviewed immutable action SHAs;
- checkout credential persistence is disabled;
- Node 24, locked `npm ci`, canonical L1 build and the controlled gateway red-team script remain mandatory;
- evidence upload is commit/run-attempt bound, fails when missing and is retained for 90 days;
- mutable action tags such as `@v4`/`@v5`/`@v7` are forbidden in this workflow.

The focused verifier and policy CI guard these invariants. Passing this workflow does **not** prove sustained hostile-Internet resilience, independent operators, public-testnet readiness or mainnet readiness. Those remain governed by the external-evidence activation trackers and existing fail-closed authorization gates.
