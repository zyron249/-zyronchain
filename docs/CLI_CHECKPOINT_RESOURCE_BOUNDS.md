# Local checkpoint install resource bounds

The published `zyron-l1 checkpoint-install` path treats operator-supplied checkpoint files as untrusted local recovery input until all external anchors and snapshot semantics are verified.

The local file is read through the descriptor-bound bounded-file primitive, capped at the same 64 MiB full-snapshot ceiling as native P2P checkpoint transfer, and required to remain the same regular file across open/read validation. The independently supplied lowercase SHA-256 snapshot anchor is verified directly over those already bounded bytes before structural scanning, UTF-8 materialization, or `JSON.parse`; hashing does not allocate another snapshot-sized copy. A digest mismatch therefore fails closed before untrusted checkpoint content can drive JSON object-graph allocation.

After the digest matches, the bounded bytes are scanned with the canonical checkpoint JSON complexity limits before parsing: maximum nesting depth 64 and maximum structural-token count 250,000. JSON punctuation inside quoted strings and escaped quotes do not consume structural quota.

These controls are availability/resource and trust-ordering hardening only. They do not replace the independent trusted tip hash, trusted finality/governance/State-v2 validation, or the target-hardware recovery evidence required by issue #383. They do not authorize public testnet, mainnet, public mining, or any release-activation gate.