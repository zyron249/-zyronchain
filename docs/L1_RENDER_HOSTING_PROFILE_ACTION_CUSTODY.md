# Render hosting-profile action custody

`Standalone L1 Render Hosting Profile Policy CI` is deployment/readiness evidence, not activation authorization. Its checkout/setup-node/upload-artifact actions are pinned to reviewed immutable SHAs and checkout credentials are not persisted.

The workflow must keep the canonical Free-profile smoke-only verifier, Node 24, commit-bound result/policy evidence, SHA-256 manifest, fail-on-missing upload, and 90-day retention. The focused custody policy CI fails closed if those controls drift.

This project-run evidence does not prove sustained uptime, independent failure domains, independent operators, target-hardware capacity, public-testnet readiness, or mainnet readiness. It therefore does not close issues #249, #260, #261, or #383 and must not be used to weaken `publicTestnetActivationAllowed`, `mainnetActivationAllowed`, public-mining, or release-publication gates.
