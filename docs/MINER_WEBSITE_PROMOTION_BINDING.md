# Miner website promotion binding

The website miner CTA is not an independent activation authority. `docs/miner-release-promotion.json` is the canonical repository promotion policy, and `scripts/verify-miner-website-promotion-binding.mjs` enforces that the website remains fail-closed while publication or public mining is gated.

While either `publicationAllowed` or `publicMiningActivated` is false, the website must keep distribution disabled, version null, and all Windows/macOS/Linux asset URLs and SHA-256 values null.

A future reviewed activation change must make the website exactly match the canonical promotion policy: all release/signing/provenance/checksum/immutability gates must be true, the source commit must be exact, all three platform assets must be trusted versioned GitHub Release URLs, every platform must carry a lowercase 64-hex SHA-256, and the website version, asset URLs, and digests must match the canonical policy byte-for-byte. Partial platform activation, URL-only activation, digest drift, or website-only activation is rejected.

When distribution is live, the selected platform's expected SHA-256 is surfaced beside the download control so the artifact identity reviewed in the promotion policy is visible to the user. The website still does not verify a local downloaded file, execute software, handle miner keys, or weaken browser/OS consent boundaries.

This control does not itself prove release signing/notarization, immutable publication, independent artifact verification, public-mining readiness, public-testnet readiness, or mainnet readiness. Those remain separately evidence-gated, and issue #390 remains stop-ship until real signed immutable end-user packages exist and public mining is intentionally activated.
