# S2-3 trust anchor T1: externally sealed restore summary

Status: specification and implementation notes for the open-testnet restore anchor
(finding S2-3, option T1). Scope: open-testnet restores only. Nothing here changes supply,
allocations, validator or oracle keys, mainnet behavior or activation flags.

Implementation: `l1/src/sealed-summary.ts` (verifier, schema, records),
`l1/scripts/open-testnet.mjs` (`restoreNetwork` hook, boot path, smoke),
`l1/scripts/open-testnet/restore-anchor.mjs` (boot anchor from pinned files, live quorum
reader, summary builder), `l1/scripts/t1-build-summary.mjs` (builder CLI),
`l1/scripts/t1-sign-summary.mjs` (signer CLI), `l1/trust/` (pinned files).
Tests: `l1/test/open-testnet-restore-independent-anchor.test.ts` (Security checklist
S23-T1..T26) and `l1/test/open-testnet-t1-anchor-impl.test.ts`.

## 1. Problem

`restoreNetwork` used to check the snapshot format, chain ID, genesis hash, keys and a full
block replay, but nothing independent of the snapshot. A correctly sealed snapshot of an
abandoned or stale branch could be restored as if it were current, and a summary read from
the same snapshot is as stale as the snapshot. T1 binds every restore to a summary that is
built from a live quorum tip match, signed by a dedicated testnet-only Ed25519 key, and
published only through reviewed repository changes.

## 2. Summary fields

A summary has exactly these 12 fields; any other, missing or extra field is refused.

| Field | Type | Meaning |
|---|---|---|
| `format` | `"zyron-open-testnet-restore-summary-v1"` | Encoding version |
| `chainId` | `^[a-z0-9][a-z0-9-]{0,63}$` | Open-testnet chain ID |
| `genesisHash` | 32-byte lowercase hex | Genesis identity; also binds the faucet / public-distribution address |
| `height` | safe non-negative integer | Height of the summarized tip |
| `tipHash` | 32-byte lowercase hex | Block hash at `height` |
| `stateRoot` | 32-byte lowercase hex | `header.stateRoot` at `height` (binds balances and the active sets in state) |
| `totalSupplyAtoms` | `^(0|[1-9][0-9]*)$` | Genesis total supply (fixed) |
| `burnedAtoms` | `^(0|[1-9][0-9]*)$` | `totalSupplyAtoms - sum(balances) - pending` at `height` (pending is 0) |
| `validatorSetHash` | 32-byte lowercase hex | Hash of the genesis validator public keys, in order |
| `oracleSetHash` | 32-byte lowercase hex | Hash of the genesis activity-oracle public keys, in order |
| `provenance` | `{ commit, publisher, workflow }` | `commit`: 40 hex of the builder's source commit; `publisher`, `workflow`: printable ASCII, 1..128 |
| `sealedAtMs` | safe non-negative integer | When the summary was sealed (informational, see section 8) |

Set hash: `SHA-256(domain || 0x00 || canonicalJson(publicKeys))`, lowercase hex, with
domains `zyronchain/open-testnet/validator-set/v1` and `zyronchain/open-testnet/oracle-set/v1`.
Hashes are checked as lowercase fixed-length hex with `codec.ts` `assertHex`.

## 3. Seal encoding and signature

- Signed message: `"zyronchain/open-testnet/restore-summary/v1" || 0x00 || canonicalJson({ keyId, summary })`.
  The message covers every summary field and the `keyId`.
- `summaryDigest = SHA-256(message)`, lowercase hex.
- Seal text (the published bytes): `canonicalJson({ keyId, signature, summary })`, no
  trailing newline. `signature` is the 64-byte Ed25519 signature (RFC 8032), lowercase hex.
- One canonicalizer: `l1/src/codec.ts` `canonicalJson` (keys sorted by UTF-16 code units, no
  whitespace, strings and safe integers as ECMAScript `JSON.stringify`). For this field set
  (printable-ASCII strings, safe non-negative integers, plain objects) its output is
  byte-identical to RFC 8785 (JCS).
- Parsing order (each step its own code): not text, not JSON (`NaN`, `+1`, `01`, truncated)
  or not a JSON object -> `RESTORE_SEAL_MALFORMED`; then the round trip
  `canonicalJson(JSON.parse(raw)) === raw` (a throw, e.g. on `1e400`, counts as a mismatch;
  `-0`, `1e2`, `1.0`, unsafe integers, whitespace, unsorted, duplicate or escaped keys,
  non-ASCII) and the strict schema -> `RESTORE_SEAL_SCHEMA_INVALID`; then the pinned key
  configuration -> `RESTORE_ANCHOR_CONFIG_INVALID`; then keys and signature.
- Hex is checked strictly before decoding: signature `/^[0-9a-f]{128}$/`, public key
  `/^[0-9a-f]{64}$/` (Node's hex decoder silently drops trailing junk).
- Encoding pinned by an RFC 8032 TEST 1 vector (test S23-T26; keyId
  `TEST-FIXTURE-ONLY-rfc8032-test1`, a public test vector, never a real key).
- Production keyIds are `t1-` + the first 32 hex of
  `SHA-256("zyronchain/open-testnet/restore-summary-key-id/v1\n" || rawPublicKey)`; the pinned
  key file refuses a keyId that does not match its key.

## 4. Where everything lives (PR-only files at the release ref)

The seal, the superseded record, the high-water record and the pinned keys are read ONLY
from files in `l1/trust/` of the checked-out release ref. They change only by a reviewed PR.
Nothing is read from the gateway, environment variables, command-line options or the
snapshot bundle (a bundle carrying `restoreSeal`, `pinnedKeys` or `restoreAnchor` is ignored).

| File | Content |
|---|---|
| `l1/trust/t1-summary-keys.json` | Pinned public keys `{ keyId, publicKey (raw 32-byte hex), addedIn }`; ships EMPTY |
| `l1/trust/t1-summary-record.json` | Append-only revoke / rotate / supersede record |
| `l1/trust/t1-high-water.json` | Separate append-only high-water log |
| `l1/trust/t1-sealed-summary.txt` | The current seal text (absent until the first seal PR) |
| `l1/trust/restore-anchor-config.json` | Chain ID and the live quorum (`threshold`, `timeoutMs`, validators `{ publicKey, url }`) |

Both records are hash chains: each entry has `index` (1, 2, ...) and `prev`
(`SHA-256(canonicalJson(previous entry))`, zeros for the first). An edited, removed or
reordered entry makes the file invalid (`RESTORE_ANCHOR_CONFIG_INVALID`).

Append-only and PR-only. A hash chain alone cannot stop a rewrite with recomputed `prev`
hashes, so the files are protected by these controls:
- CI check: `l1/scripts/t1-trust-append-only.mjs`. It fails unless every trust JSON file at the
  head is byte-canonical (exactly `JSON.stringify(value, null, 2)` plus one trailing newline,
  no duplicate object keys), the base entries of `t1-summary-record.json` and
  `t1-high-water.json` are an unchanged prefix of the head entries (byte-identical canonical
  JSON at the same positions, valid index / prev chain), every base key in
  `t1-summary-keys.json` is still pinned unchanged at the same position (keys are only added;
  revocation and rotation go through the record, never through edits; each keyId is derived
  from its key), none of these files is deleted, and the local test-fixture marker
  `TEST-FIXTURE-ONLY-loopback-quorum` is absent. The seal text and the quorum config may change.
  The boot loader applies the same byte-canonical and duplicate-key rule
  (`RESTORE_ANCHOR_CONFIG_INVALID`).
  - The script is self-contained (Node built-ins only, no `l1/dist`), so CI can run a copy
    taken from `main` without building or running any code of the change under review.
  - Tamper-proof check: `.github/workflows/l1-t1-trust-append-only.yml`. It runs under
    `pull_request_target` for pull requests into `main` only, so GitHub runs this workflow
    file and the checker exactly as they are on `main`; a PR cannot disable or edit either.
    It checks out `main`, fetches the PR head as git data only and reads it with `git show`
    through the checker; it never checks out, installs, builds, evaluates or runs PR content,
    uses no secrets, has `contents: read` only and does not persist credentials. Its `edited`
    trigger re-runs it when a PR is retargeted, so a stacked PR is checked once it targets
    `main`. If the checker is missing on `main` the job fails. Its exact shape is pinned by
    `.github/scripts/verify-l1-t1-trust-append-only-custody.mjs` (an allowlist, with a
    mutation test): the file must be ASCII with no control character other than LF, only
    lines matching `^ *#` outside block scalars count as comments, and every other line
    must match exactly. Only this job gives the "cannot be disabled by the PR" property.
  - Defence in depth: the Standalone L1 job (`.github/workflows/l1.yml`) runs the same check
    as its first step after checkout and Node setup, before `npm ci`, with the checker taken
    by `git show <ref>:l1/scripts/t1-trust-append-only.mjs` from the merge base with `main`
    (pull requests) or the previous `main` (pushes). That ref's copy is used, except when it
    has none yet (bootstrap, logged as a warning). Because `l1.yml` is part of the change, a
    PR can edit this step; it is not tamper-proof. The custody check parses the `l1` job
    and requires its header, the checkout and Node setup steps and this step (with its exact
    `if:`) to match an allowlist, so no install or script step can run before it in that job.
  - Pull requests are compared with `git merge-base origin/main HEAD` (`--merge-base`), not
    with the PR's base SHA. Pushes to `main` are compared with `github.event.before`
    (`--push-before`); an all-zero before SHA falls back to the first parent (or an empty base
    for a root commit), and an unknown one fails closed.
  - Bootstrap: until the change that adds the checker and the `pull_request_target` workflow
    is on `main`, the tamper-proof job does not run at all (GitHub only runs it from `main`),
    and the `l1.yml` step falls back to the change's own checker for every PR. Protection
    starts when that change lands on `main`; the anchor-pin PR must come after it.
- Review: every change to `l1/trust/` (and to the checker, the workflows and
  `l1/src/sealed-summary.ts`) needs a Zyron Security review and the owner's explicit merge OK.
  This is a process control, not a GitHub-enforced one.
- CODEOWNERS review is advisory in this repository (`.github/CODEOWNERS` lists `/l1/trust/`).
  Enforcement is the append-only CI check plus Security review plus the owner's explicit merge
  OK. Branch protection (required reviews, required checks) is an owner decision still
  pending; until then no GitHub setting enforces the review or the checks above.

Record kinds: `revoke-key { keyId }` (the key is `revoked: true`), `supersede-key { keyId,
supersededAtHeight }` (the key only covers summaries with `height < supersededAtHeight`),
`supersede-summary { summaryDigest, height, tipHash }` (that seal, or any seal for that tip, is
refused). Revoked wins over `supersededAtHeight`.

High-water: each entry `{ chainId, height, tipHash, summaryDigest }` records one seal accepted
for publication. Its effective value for a chain is the highest entry whose seal is not
superseded, where a `supersede-summary` entry matches by `summaryDigest` or by `height` and
`tipHash` together. Superseding the H+50 seal, or the H+50 tip, makes it resolve to the seal at
H, so a superseded tip never deadlocks the restore at REPLAY_LOWER_HEIGHT. It is never derived
from the superseded list. A new seal enters by one PR that adds the seal text and appends its
high-water entry together (`t1-build-summary.mjs high-water`); a restore refuses a seal above
the effective high-water (`RESTORE_SUMMARY_HIGH_WATER_CONFLICT`) or below it
(`RESTORE_SUMMARY_REPLAY_LOWER_HEIGHT`), and a different seal at the same height (conflict).
The effective value carries the entry's `tipHash`, and the restore refuses a seal whose
`tipHash` differs from it (`RESTORE_SUMMARY_HIGH_WATER_CONFLICT`); two live (not superseded)
entries at the same height with different tips are a conflict too.

## 5. Provenance: who builds and publishes the summary

1. A validator operator runs `node l1/scripts/t1-build-summary.mjs build --network-dir <dir>
   --validator vN --height H --publisher ... --workflow ... --commit <sha>` on its own node.
   The builder reads the live quorum tip at H from the validators pinned in
   `restore-anchor-config.json` (below), replays that validator's OWN finalized log to H, and
   refuses unless the replayed tip equals the quorum tip. It never reads a snapshot.
2. The key custodian (Patron) signs it with `t1-sign-summary.mjs` (section 7).
3. `t1-build-summary.mjs assemble` produces the seal text and checks it against the pinned keys;
   `high-water` produces the appended high-water file.
4. A PR adds both files; Patron and Security review it; it is merged only with the owner's
   explicit OK.
   `provenance.publisher` and `provenance.workflow` name who built it and with what.

Live quorum tip (restore and builder): `GET {url}/block/{height}` from each pinned validator;
a block counts only if its hash recomputes over its header, its height and chain ID match, and
its secp256k1 finality attestations verify against the pinned validator keys. The tip needs at
least `threshold` distinct trusted attesters (threshold in [floor(2n/3)+1, n], n >= 3) from
verified sources on at least two distinct sites (one host answering for every validator is
not a quorum). The pinned config must list distinct URLs from at least two sites, each
`https` on a public host.

- Site (`quorumSourceSite`): the host lowercased, with trailing dots, port and scheme
  dropped, and a DNS name collapsed to its registrable domain by a simple eTLD+1 rule (the
  last two labels, or three when the second-to-last is a common second-level suffix such as
  `co`, `com`, `org` under a two-letter country TLD; no public-suffix dependency). An IP
  literal is its own site. So port, trailing-dot and subdomain variants of one host are one
  site. The rule is conservative: tenants of one shared hosting suffix count as one site.
- Non-public hosts are refused (`RESTORE_ANCHOR_CONFIG_INVALID`): localhost, `.local`,
  `.internal`; IPv4 0/8, loopback, RFC 1918, CGNAT, link-local, 192.0.0.0/24, documentation
  ranges, 6to4 relay anycast 192.88.99.0/24, 198.18.0.0/15, multicast and reserved; IPv6
  `::/8` (unspecified, loopback, IPv4-compatible and IPv4-mapped), discard `100::/64`, NAT64
  `64:ff9b::/96` and `64:ff9b:1::/48`, Teredo `2001::/32`, `2001:2::/48`, `2001:db8::/32`,
  6to4 `2002::/16`, unique-local `fc00::/7`, link-local `fe80::/10`, site-local `fec0::/10`
  and multicast `ff00::/8`. IPv6 addresses are parsed into their eight groups first; one that
  does not parse is refused.
- Resolved addresses: before any request the quorum reader resolves every source host (all
  addresses) and refuses the read (`RESTORE_ANCHOR_CONFIG_INVALID`) if any address is
  non-public, so a public-looking name that points at a private address (nip.io style) fails.
  A lookup failure counts that source as not answering. The request then connects only to the
  first checked address (`pinnedFetch`: `node:https` / `node:http` with a per-request `lookup`
  that returns the pinned address and a fresh agent), while the URL keeps the hostname, so SNI,
  certificate verification and the `Host` header use the name. A rebinding answer between the
  check and the request is never used. The tip still rests on the secp256k1 attestations.
- `http://127.0.0.1` sources (each port its own site) are accepted only in a local test fixture
  trust directory that carries the `TEST-FIXTURE-ONLY-loopback-quorum` marker, which the CI
  check above keeps out of the repository; they are not resolved. Two verified tips -> `RESTORE_QUORUM_TIP_MISMATCH`; deadline ->
`RESTORE_QUORUM_TIP_TIMEOUT`; too few -> `RESTORE_QUORUM_TIP_UNAVAILABLE`.

## 6. Restore checks (order) and refusal codes

`restoreNetwork(dir, bundle, chainId, { restoreAnchor })` with `restoreAnchor = { pinnedKeys,
readSeal() -> raw text | null, readSuperseded(), readHighWater() -> { height, summaryDigest, tipHash? },
readQuorumTip(height), timeoutMs }`. Every read is bounded by `timeoutMs` (default 30 s; timers
are cleared). Refusals are `RestoreAnchorError` with a `code`, never a `cause` or `syscall`, so
`isLocalIoError` never treats them as disk failures and `restoreNetworkWithLocalRetry` (which
forwards `restoreAnchor`) never retries them.

Order: anchor present; seal read; seal parse/schema; pinned config; validator/oracle/faucet
keys; keyId; revoked; rotated; signature; superseded; high-water; chain; genesis; sets; height;
live quorum tip; snapshot tip; then (after writes, into staging) replay and the post-replay
checks, repeated just before the completion marker. The restore writes into
`<dir>.restore-staging` and renames it onto `<dir>` only after every check passed and the
marker is written, so a refusal or crash never leaves restore output at the target. A refusal
removes this attempt's staging directory. A staging directory left over by a crash is moved aside
before the restore runs again from the bundle, and never deleted or promoted: an incomplete one
like any incomplete network directory (`<staging>.incomplete-<ms>-<pid>/`), and one that already
holds a completion marker (a crash between the marker and the rename) to
`<staging>.leftover-<ms>-<pid>`. At most 3 such `.leftover-*` directories are kept: with 3
already there the restore is refused (`RESTORE_STAGING_LEFTOVER_LIMIT`) before anything is
renamed or written, and an operator inspects and removes them. Nothing is deleted automatically.

| Code | When |
|---|---|
| `RESTORE_ANCHOR_MISSING` | No anchor (incl. the shipped placeholder: no pinned key) |
| `RESTORE_ANCHOR_CONFIG_INVALID` | Pinned keys / records / config malformed (exact `{keyId, publicKey, revoked, supersededAtHeight?}`, strict hex, no duplicates, >= 1 key) |
| `RESTORE_ANCHOR_UNAVAILABLE` | Seal / superseded / high-water read failed |
| `RESTORE_ANCHOR_TIMEOUT` | Seal / superseded / high-water read exceeded `timeoutMs` |
| `RESTORE_SEAL_MISSING` | Nothing sealed |
| `RESTORE_SEAL_MALFORMED` | Not text, not JSON, not an object |
| `RESTORE_SEAL_SCHEMA_INVALID` | Schema or canonical round-trip failure |
| `RESTORE_SEAL_INVALID_SIGNATURE` | Bad signature or encoding (tampered field, wrong message form) |
| `RESTORE_SEAL_UNKNOWN_KEY_ID` | keyId not pinned (wrong keyId) |
| `RESTORE_SEAL_KEY_REVOKED` | Key revoked |
| `RESTORE_SEAL_KEY_SUPERSEDED` | `height >= supersededAtHeight` |
| `RESTORE_SEAL_VALIDATOR_KEY` | keyId is a validator/oracle/faucet address or key, the seal is signed by one, or a pinned key is one's x-coordinate |
| `RESTORE_SUMMARY_SUPERSEDED` | Seal or its tip superseded |
| `RESTORE_SUMMARY_REPLAY_LOWER_HEIGHT` | Below the effective high-water |
| `RESTORE_SUMMARY_HIGH_WATER_CONFLICT` | Above it, a different seal or tip at it, two live tips at one height, or no entry |
| `RESTORE_SUMMARY_WRONG_CHAIN` | Other chain ID |
| `RESTORE_SUMMARY_GENESIS_MISMATCH` | Other genesis (impostor bundle) |
| `RESTORE_SUMMARY_VALIDATOR_SET_MISMATCH` / `RESTORE_SUMMARY_ORACLE_SET_MISMATCH` | Set hash differs |
| `RESTORE_SUMMARY_STALE` / `RESTORE_SUMMARY_ABOVE_TIP` | Summary below / above the snapshot tip |
| `RESTORE_QUORUM_TIP_UNAVAILABLE` / `_TIMEOUT` / `_MISMATCH` | Live quorum (section 5) |
| `RESTORE_SUMMARY_TIP_MISMATCH` | Snapshot or replayed tip differs |
| `RESTORE_SUMMARY_STATE_MISMATCH` | Replayed state root differs |
| `RESTORE_SUMMARY_SUPPLY_MISMATCH` | Total differs, or balances + pending + burned != MAX_SUPPLY_ATOMS (50,000,000 ZYN) |
| `RESTORE_SUMMARY_BURN_MISMATCH` | Burned atoms differ |
| `RESTORE_SNAPSHOT_CORRUPT` | Snapshot cannot be opened or replayed (e.g. tampered attestation) |
| `RESTORE_STAGING_LEFTOVER_LIMIT` | 3 leftover staging directories are already kept beside the target |

## 7. Key custody, rotation, revocation, compromise

- The key is Ed25519, single-purpose (open-testnet restore summaries only), testnet-only,
  never reused for or derived from any validator, oracle, faucet, deploy or other key.
- No key is generated by this change. After the implementation head is ready, Patron (not an
  agent) generates it and keeps it outside `/workspace`, mode 0600. Only the public key and
  keyId enter the repository, by a later PR reviewed by Patron and Security.
- The key is never placed in the gateway, Render, CI, environment variables or logs. The signer
  `t1-sign-summary.mjs --summary <file> --key-file <path>` reads it only from an absolute path
  whose real directory is outside `/workspace` and the repository. It opens the file with
  `lstat` first (a regular file with exactly one link, not a symlink), then opens it with
  `O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY` (a symlink fails, a FIFO cannot block) and
  checks the open descriptor with `fstat` (regular file, the same device and inode as the
  `lstat`, exactly one link, mode 0600, owned by the user, bounded size), reads it into a Buffer, builds the KeyObject from that Buffer and
  zeroes the Buffer (`fill(0)`). It refuses key material on the command line or in the
  environment and prints only `{"keyId","signature"}`.
- Independence is weaker than a separate machine: the signer runs on the same shared machine
  as other automated tooling, so a compromise of that machine can reach the key file. The live quorum
  tip match and PR review of every seal limit what a stolen key can do alone.
- Rotation (PR, Patron + Security): pin the new key; append `supersede-key { old keyId,
  supersededAtHeight }`; publish the next seal under the new key.
- Revocation (PR, Patron + Security): append `revoke-key`; append `supersede-summary` for any
  seal it signed that must no longer restore; publish a new seal under another key.
- Compromise runbook: (1) revoke by PR immediately; (2) supersede every seal the key signed after
  the suspected time; (3) generate a new key outside `/workspace`, pin it by PR; (4) rebuild and
  re-seal from a live quorum; (5) record the incident in the PR. Restores refuse until (4).

## 8. sealedAtMs

There is no freshness rule on `sealedAtMs`: a snapshot can legitimately be restored long after
its seal. Freshness comes from the high-water record, the superseded record and the live quorum
tip match, which a stale seal cannot pass. `sealedAtMs` is signed and informational.

## 9. Boot, smoke and test seams

- Boot (`run --init-if-missing` with a restore URL): after a 200 download and before
  decryption, the anchor is built from the `l1/trust/` files only. With the shipped placeholder
  the start-up logs `STATE RESTORE FAILED ([RESTORE_ANCHOR_MISSING] ...)`, exits 1 and never
  creates a fresh genesis. Behavior change: hosted restores are refused until a key, a seal, a
  high-water entry and a quorum are pinned by PR.
- Smoke: builds a summary from the validators' own logs, signs it with a runtime TEST key and
  restores with that fixture anchor; it asserts the unanchored restore is refused.
- No test seam: the boot always reads `l1/trust/` next to its own scripts (the checkout of the
  release ref). There is no environment variable, option, global or preload hook that redirects
  it, so `NODE_OPTIONS=--import ...` cannot point a production boot at other files. CLI tests run
  a copy of `l1/scripts` in a temporary l1 tree (with `dist`, `node_modules` and `package.json`
  linked) whose `trust/` holds fixture files.
