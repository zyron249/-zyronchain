# Standalone L1 launch-authorization action custody

The launch-authorization workflow verifies governance authorization and the fail-closed public-testnet/mainnet activation policy. Its CI action boundary is pinned to reviewed immutable checkout, setup-node and upload-artifact commits, with checkout credential persistence disabled.

The focused policy verifier also requires least-privilege contents-only permissions, Node 24, the canonical `verify-launch-authorization.mjs` policy check, SHA-256 evidence covering both the policy and result, commit/run-attempt-bound artifact naming, fail-on-missing upload behavior and 90-day retention.

This hardening does not change governance authorization values or activation flags. `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false` remain evidence-gated until their independent external requirements are satisfied.
