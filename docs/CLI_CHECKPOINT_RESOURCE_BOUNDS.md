# Local checkpoint install resource bounds

The published `zyron-l1 checkpoint-install` path treats operator-supplied checkpoint files as untrusted local recovery input until all external anchors and snapshot semantics are verified.

The local file is read through the descriptor-bound bounded-file primitive, capped at the same 64 MiB full-snapshot ceiling as native P2P checkpoint transfer, and required to remain the same regular file across open/read validation.

The `--sha256` anchor retains its established meaning: it is the SHA-256 digest of `canonicalJson(snapshot)`, not a digest of arbitrary whole-file formatting. ZyronChain snapshot writers persist that canonical payload followed by one transport LF. The local checkpoint reader therefore hashes the already bounded canonical payload bytes, excluding that single terminal LF when present, before structural scanning, UTF-8 materialization, or `JSON.parse`. The LF is removed with a Buffer view rather than another snapshot-sized copy. Other formatting changes are not normalized at this pre-parse boundary and fail the digest check instead of silently redefining the trusted anchor.

After the digest matches, the bounded bytes are scanned with the canonical checkpoint JSON complexity limits before parsing: maximum nesting depth 64 and maximum structural-token count 250,000. JSON punctuation inside quoted strings and escaped quotes do not consume structural quota. Parsed snapshot semantics, finality, governance schedules, State-v2 state and the trusted tip hash are then revalidated by the existing trusted-snapshot installation path.

These controls are availability/resource and trust-ordering hardening only. They do not replace the independent trusted tip hash, trusted finality/governance/State-v2 validation, or the target-hardware recovery evidence required by issue #383. They do not authorize public testnet, mainnet, public mining, or any release-activation gate.