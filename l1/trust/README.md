# T1 restore trust anchor (open testnet only)

See `docs/specs/s2-3-t1-sealed-summary.md`.

- `t1-summary-keys.json`: pinned Ed25519 public keys (raw 32 bytes, hex) and keyIds of the
  testnet summary-signing key. Starts empty: with no pinned key every open-testnet restore fails
  with `anchor_missing`. Keys are added only by a reviewed PR (Patron and Security).
- `t1-summary-record.json`: append-only revoke / supersede / floor record. Never edit or delete
  an entry; append a new one.

No private key ever goes in this directory or anywhere in the repository.
