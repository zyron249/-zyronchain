# Native peer-reputation persistence custody

The native peer-reputation snapshot is local operational state, not consensus or activation evidence. Its persistence path is fail-closed so corrupted state cannot silently widen peer admission policy.

`native-peer-reputation.json` is read through the bounded local-file custody layer with a 2 MiB hard byte ceiling. Before `JSON.parse` allocates an object graph, the node scans the byte-bounded text and rejects JSON whose nesting exceeds 16 levels or whose object/array structural-token count exceeds 8,192. Punctuation inside quoted or escaped JSON strings is ignored by the structural counter.

These parser bounds are intentionally much larger than the canonical schema needs: one version field plus at most 256 shallow peer entries. They do not replace the exact schema, duplicate-PeerId rejection, PeerId validation, failure-count bounds, active-penalty capacity rules, or atomic persistence behavior.

This hardening is a local availability/corruption boundary only. It is not evidence that public testnet, mainnet, or any external deployment is ready.
