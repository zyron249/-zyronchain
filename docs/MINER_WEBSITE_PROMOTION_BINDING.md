# Miner website promotion binding

The website miner CTA is not an independent activation authority. `docs/miner-release-promotion.json` is the canonical repository promotion policy, and `scripts/verify-miner-website-promotion-binding.mjs` enforces that the website remains fail-closed while publication or public mining is gated.

While either `publicationAllowed` or `publicMiningActivated` is false, the website must keep distribution disabled, version null, and all Windows/macOS/Linux asset URLs null.

A future reviewed activation change must make the website exactly match the canonical promotion policy: all release/signing/provenance/checksum/immutability gates must be true, the source commit must be exact, all three platform assets must be trusted versioned GitHub Release URLs, and the website version and asset URLs must match byte-for-byte. Partial platform activation or website-only activation is rejected.

This control does not itself prove release signing, public-mining readiness, public-testnet readiness, or mainnet readiness. Those remain separately evidence-gated.
