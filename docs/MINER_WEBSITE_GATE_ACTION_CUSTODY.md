# Miner Website Gate Action Custody

The Miner Website Fail-Closed Gate CI is part of the public mining activation boundary. Its GitHub Actions dependencies are pinned to reviewed immutable commit SHAs and checkout credentials must not persist after source retrieval.

The focused custody verifier requires Node 24 and preserves the existing website fail-closed assertions: miner distribution remains disabled, public mining remains disabled, Windows/macOS/Linux asset URLs remain null, the mining page keeps `connect-src 'none'`, and the website must not request or persist miner custody secrets.

This control is CI supply-chain hardening only. It does not authorize release publication, bind downloadable miner assets, or establish public-mining/public-testnet/mainnet readiness. Any future activation still requires the canonical release-promotion and activation evidence gates to be independently satisfied.
