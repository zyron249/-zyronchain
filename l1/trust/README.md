# T1 restore trust anchor (open testnet only)

See `docs/specs/s2-3-t1-sealed-summary.md`. Every file here changes only by a reviewed PR
(Patron and Security). The open-testnet boot reads the restore anchor only from these files
at the checked-out release ref, never from the gateway, environment variables, options or the
snapshot.

- `t1-summary-keys.json`: pinned Ed25519 public keys (raw 32 bytes, lowercase hex) and keyIds of
  the testnet restore-summary key. Ships EMPTY: with no pinned key every open-testnet restore is
  refused with `RESTORE_ANCHOR_MISSING`.
- `t1-summary-record.json`: append-only revoke-key / supersede-key / supersede-summary record
  (index + prev hash chain). Never edit or delete an entry; append a new one.
- `t1-high-water.json`: separate append-only high-water log. A new seal and its high-water entry
  are added in the same PR.
- `t1-sealed-summary.txt`: the current seal text (absent until the first seal PR).
- `restore-anchor-config.json`: chain ID and the live quorum validators used for the quorum tip
  match. Placeholder until the key is pinned.

No private key ever goes in this directory or anywhere in the repository.
