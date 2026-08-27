# State-v2 legacy migration recovery boundary

This document records the one-time recovery boundary used when a node upgrades from the historical NDJSON State-v2 persistence format to the indexed SQLite backend.

## Bounded migration

Legacy `state-v2.nodes.ndjson` and `state-v2.keys.ndjson` inputs are consumed incrementally. The migration does not read or split either complete file into JavaScript memory. Node records are limited to 64 KiB per newline-terminated record, semantic-key records are limited to 1 KiB, input is read in bounded chunks, and validated records are committed to SQLite in batches of at most 256 entries. The normal State-v2 resolver cache remains separately bounded.

Every complete legacy JSON line is structurally preflighted before `JSON.parse()`. Node envelopes are limited to 64 levels of nesting and 16,384 structural tokens; semantic-key envelopes are limited to 16 levels and 128 structural tokens. Brackets, braces, commas and colons inside quoted or escaped JSON strings are ignored by the structural scan, so semantic key text does not consume parser-complexity budget.

An unterminated final record is treated as the historical crash tail and is ignored. A newline-terminated record that exceeds its byte or structural-complexity limit is rejected before JSON parsing. Checksums, duplicate/conflict detection, root authentication and semantic-key verification remain fail-closed.

## Cutover ordering

The SQLite backend marker is published only after the migrated database can independently resolve and authenticate the committed State-v2 root. The semantic-key backend marker is published only after each streamed key batch has been durably inserted and its hash/preimage binding can be read back from the indexed store. Existing marker files retain their atomic temporary-file, fsync, rename and parent-directory fsync publication boundary.

A crash before either marker is published is restart-safe: migration is idempotent because content-addressed node insertion and semantic-key insertion reject conflicting duplicates while accepting identical rows. Once a valid marker exists, the corresponding legacy NDJSON file is no longer a trust source.

## Readiness scope

This hardening reduces upgrade/recovery memory and parser/object-graph amplification from malformed legacy records. It does not change consensus rules, State-v2 root semantics, validator authorization, mining activation, public-testnet activation or mainnet activation. Synthetic regression coverage is not evidence that public testnet or mainnet operational gates are satisfied.
