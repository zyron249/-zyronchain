# Website release-pin CI custody boundary

The Website Canonical Release Pin CI is a release/security boundary. It validates that website/release.js points at the reviewed pull-request base commit, that no canonical L1/security changes escape that pin, and that the website preserves its offline browser/CSP and mining-disclosure requirements.

The workflow therefore uses only an immutable reviewed checkout action SHA, disables checkout credential persistence, and fetches full history only for the release-pin comparison. A focused policy verifier rejects mutable action references, re-enabled credentials, loss of full-history checkout, or removal of the core release/security assertions.

This hardening does not authorize miner publication, public mining, public testnet, or mainnet. Those activation gates remain independently fail-closed.
