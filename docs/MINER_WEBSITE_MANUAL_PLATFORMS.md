# Miner website manual platform alternatives

The Mining Launchpad exposes Windows, macOS and Linux manual platform choices so users are not forced to rely on user-agent detection.

These controls are intentionally disabled while the canonical miner promotion policy remains fail-closed. Their presence is UX preparation only and does not authorize a release, public mining, public testnet or mainnet.

A future activation PR may make a platform choice downloadable only after the existing miner release-promotion and website-promotion-binding checks prove that the corresponding immutable GitHub Release asset, checksum, provenance and required signing/notarization evidence match the reviewed canonical release policy and public mining is explicitly activated.

The website must never fetch activation state dynamically, persist custody/distribution state, request miner secrets, mine in the browser or silently execute downloaded software. The browser/operating system remains responsible for explicit user consent before opening or running downloaded software.
