# Render testnet material reuse

The non-value-bearing Render rehearsal reuses validator key files through the same descriptor-bound private-file reader used by the Layer-1 runtime. Persisted validator keys must be regular files, use owner-only POSIX permissions, remain bound to the opened descriptor/path identity, and fit within the existing 64 KiB private-file read limit.

Persisted `genesis.json` is read through the regular control-file reader with a 64 KiB limit before parsing. Reused material must still match the configured chain ID and four-validator set, each key must reproduce its stored public key and address, and the resulting genesis must pass canonical `ZyronChain` validation.

These checks apply only to local reuse in the private Render rehearsal. They do not establish durable production custody, sustained availability, independent operation, public-testnet activation, or mainnet readiness.
