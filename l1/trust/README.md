# T1 restore trust anchor (open testnet only)

See `docs/specs/s2-3-t1-sealed-summary.md` (section 4). Every file here changes only by a PR.
Enforcement is: the append-only CI check `l1/scripts/t1-trust-append-only.mjs` (record and
high-water entries are append-only, base entries an unchanged prefix of head entries; pinned
keys are only added; every JSON file is byte-canonical, `JSON.stringify(value, null, 2)` plus
one newline, with no duplicate keys), run by the `pull_request_target` workflow on `main` (tamper-proof) and,
as defence in depth, by the Standalone L1 job; plus a Zyron Security review; plus the owner's
explicit merge OK. CODEOWNERS review is advisory in this repository; enforcement is the append-only CI
check plus Security review plus the owner's explicit merge OK; branch protection is an owner
decision still pending. The open-testnet boot reads the restore anchor only from these files
at the checked-out release ref, never from the gateway, environment variables, options or the
snapshot.

- `t1-summary-keys.json`: pinned Ed25519 public keys (raw 32 bytes, lowercase hex) and keyIds of
  the testnet restore-summary key. Ships EMPTY: with no pinned key every open-testnet restore is
  refused with `RESTORE_ANCHOR_MISSING`.
- `t1-summary-record.json`: append-only revoke-key / supersede-key / supersede-summary record
  (index + prev hash chain). Never edit or delete an entry; append a new one.
- `t1-high-water.json`: separate append-only high-water log (`chainId`, `height`, `tipHash`,
  `summaryDigest` per seal). A new seal and its high-water entry
  are added in the same PR.
- `t1-sealed-summary.txt`: the current seal text (absent until the first seal PR).
- `restore-anchor-config.json`: chain ID and the live quorum validators used for the quorum tip
  match. Placeholder until the key is pinned.

No private key ever goes in this directory or anywhere in the repository.
