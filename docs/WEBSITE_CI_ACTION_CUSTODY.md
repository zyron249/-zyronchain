# Website CI action custody

The production website and miner-facing website policy workflows are part of the release/security boundary even though they do not hold runtime secrets.

They must use reviewed immutable GitHub Action commit SHAs, disable checkout credential persistence, and run under Node 24. Production Website CI must additionally retain full Git history because it verifies that `website/release.js` references an existing ancestor commit.

The dedicated `Website CI Action Custody Policy CI` fails closed if those action/runtime boundaries drift or if the canonical production/miner verifier commands are removed.

This hardening does not activate public mining, public testnet, mainnet, release publication, validator enrollment, or browser custody. Those gates remain independently fail-closed and evidence-gated.
