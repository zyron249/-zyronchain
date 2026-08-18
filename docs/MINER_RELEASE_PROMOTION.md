# Miner release promotion boundary

ZyronChain miner packaging and miner publication are separate security boundaries. Candidate workflows may build, checksum, attest, and smoke-test self-contained Windows/macOS/Linux artifacts while public mining remains disabled. Candidate availability alone is not authorization to publish or advertise mining as live.

`docs/miner-release-promotion.json` is the fail-closed promotion policy. While launch evidence is incomplete it must keep every activation/publication boolean false, exactly the `windows`, `macos`, and `linux` platform asset keys present with null values, and every evidence reference null. The promotion verifier rejects missing/extra platform keys, partial activation, partial asset publication, untrusted asset origins, non-exact source identities, mutable-release state, or missing evidence.

A future reviewed promotion change must bind one exact 40-hex source commit and one versioned `miner-v*` release tag to all three GitHub Release assets. It must carry reviewable evidence for Windows signing, macOS signing/notarization, provenance, checksums, immutable release state, and explicit public-mining activation. The verifier does not prove those external facts by itself; it only prevents the repository policy from representing a partially evidenced promotion as authorized.

Website download activation remains a separate reviewed step and must consume only the same immutable GitHub Release assets after this policy and the public-mining launch gates are independently satisfied. No website or release workflow may infer authorization from successful candidate CI alone.
