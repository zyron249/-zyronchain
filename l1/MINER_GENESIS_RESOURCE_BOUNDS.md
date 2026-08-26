# Miner genesis resource bounds

ZyronChain treats packaged or operator-supplied miner genesis JSON as bounded local control input rather than an unbounded parser workload.

The miner genesis reader keeps the existing 256 KiB hard byte ceiling and the shared descriptor/path custody boundary. Before `JSON.parse` materializes an object graph, it additionally rejects JSON whose nesting depth exceeds 64 or whose structural-token count exceeds 100,000. Structural punctuation inside JSON strings is ignored by the preflight scanner.

These limits are availability and resource-accounting hardening only. They do not change the canonical genesis schema, chain identity, consensus/finality rules, mining activation, release signing/provenance requirements, or any public-mining/testnet/mainnet gate. A canonical genesis must still pass the existing downstream semantic validation.

The exact 256 KiB byte-boundary regression remains required. Dedicated regressions also require excessive nesting and punctuation-dense input to fail closed before `JSON.parse`.
