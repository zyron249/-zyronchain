# Signing-journal JSON complexity boundary

The validator signing journal is consensus-safety custody state. Each serialized record remains limited to 1,024 bytes, but byte length alone is not the parser/object-graph resource boundary.

Before a complete non-empty signing-journal record is passed to `JSON.parse`, the node must enforce a deterministic structural-complexity preflight. The bound is 16 levels of JSON nesting and 128 structural tokens (`{`, `}`, `[`, `]`, `,`, `:`). Punctuation inside quoted or escaped JSON strings is ignored by the structural count.

This preflight is additive. It does not change signing-slot conflict prevention, `(height, round)` reservation identity, the 1,024-byte line ceiling, crash-tail handling, exclusive-writer custody, append/fsync fail-stop behavior, directory durability, or compaction semantics. Malformed or over-complex complete records fail closed before semantic replay.

This hardening is not public-testnet or mainnet readiness evidence. External custody, protected hosting, recovery, adversarial operation, and activation evidence remain independently required.
