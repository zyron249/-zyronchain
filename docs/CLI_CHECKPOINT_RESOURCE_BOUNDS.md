# Local checkpoint install resource bounds

The published `zyron-l1 checkpoint-install` path treats operator-supplied checkpoint files as untrusted local recovery input until all external anchors and snapshot semantics are verified.

The local file is read through the descriptor-bound bounded-file primitive, capped at the same 64 MiB full-snapshot ceiling as native P2P checkpoint transfer, and required to remain the same regular file across open/read validation. Before UTF-8 materialization reaches `JSON.parse`, the already bounded bytes are scanned with the canonical checkpoint JSON complexity limits: maximum nesting depth 64 and maximum structural-token count 250,000. JSON punctuation inside quoted strings and escaped quotes do not consume structural quota.

These controls are availability/resource hardening only. They do not replace the independent trusted tip hash and SHA-256 snapshot anchors, trusted finality/governance/State-v2 validation, or the target-hardware recovery evidence required by issue #383. They do not authorize public testnet, mainnet, public mining, or any release-activation gate.
