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

Record kinds: `revoke-key { keyId }` (the key is `revoked: true`), `supersede-key { keyId,
supersededAtHeight }` (the key only covers summaries with `height < supersededAtHeight`),
`supersede-summary { summaryDigest, height, tipHash }` (that seal, or any seal for that tip, is
refused). Revoked wins over `supersededAtHeight`.

High-water: each entry `{ chainId, height, summaryDigest }` records one seal accepted for
publication. Its effective value for a chain is the highest entry whose seal is not
superseded; superseding the seal at H+50 makes it resolve to the seal at H. It is never derived
from the superseded list. A new seal enters by one PR that adds the seal text and appends its
high-water entry together (`t1-build-summary.mjs high-water`); a restore refuses a seal above
the effective high-water (`RESTORE_SUMMARY_HIGH_WATER_CONFLICT`) or below it
(`RESTORE_SUMMARY_REPLAY_LOWER_HEIGHT`), and a different seal at the same height (conflict).

## 5. Provenance: who builds and publishes the summary

1. A validator operator runs `node l1/scripts/t1-build-summary.mjs build --network-dir <dir>
   --validator vN --height H --publisher ... --workflow ... --commit <sha>` on its own node.
   The builder reads the live quorum tip at H from the validators pinned in
   `restore-anchor-config.json` (below), replays that validator's OWN finalized log to H, and
   refuses unless the replayed tip equals the quorum tip. It never reads a snapshot.
2. The key custodian (Patron) signs it with `t1-sign-summary.mjs` (section 7).
3. `t1-build-summary.mjs assemble` produces the seal text and checks it against the pinned keys;
   `high-water` produces the appended high-water file.
4. A PR adds both files; Patron and Security review it; it is merged by a maintainer.
   `provenance.publisher` and `provenance.workflow` name who built it and with what.

Live quorum tip (restore and builder): `GET {url}/block/{height}` from each pinned validator;
a block counts only if its hash recomputes over its header, its height and chain ID match, and
its secp256k1 finality attestations verify against the pinned validator keys. The tip needs at
least `threshold` distinct trusted attesters (threshold in [floor(2n/3)+1, n], n >= 3) from at
least two sources. Two verified tips -> `RESTORE_QUORUM_TIP_MISMATCH`; deadline ->
`RESTORE_QUORUM_TIP_TIMEOUT`; too few -> `RESTORE_QUORUM_TIP_UNAVAILABLE`.

## 6. Restore checks (order) and refusal codes

`restoreNetwork(dir, bundle, chainId, { restoreAnchor })` with `restoreAnchor = { pinnedKeys,
readSeal() -> raw text | null, readSuperseded(), readHighWater() -> { height, summaryDigest },
readQuorumTip(height), timeoutMs }`. Every read is bounded by `timeoutMs` (default 30 s; timers
are cleared). Refusals are `RestoreAnchorError` with a `code`, never a `cause` or `syscall`, so
`isLocalIoError` never treats them as disk failures and `restoreNetworkWithLocalRetry` (which
forwards `restoreAnchor`) never retries them.

Order: anchor present; seal read; seal parse/schema; pinned config; validator/oracle/faucet
keys; keyId; revoked; rotated; signature; superseded; high-water; chain; genesis; sets; height;
live quorum tip; snapshot tip; then (after writes, into staging) replay and the post-replay
checks, repeated just before the completion marker. The restore writes into
`<dir>.restore-staging` and renames it onto `<dir>` only after every check passed and the
marker is written, so a refusal or crash never leaves restore output at the target.

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
| `RESTORE_SUMMARY_HIGH_WATER_CONFLICT` | Above it, a different seal at it, or no entry |
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

## 7. Key custody, rotation, revocation, compromise

- The key is Ed25519, single-purpose (open-testnet restore summaries only), testnet-only,
  never reused for or derived from any validator, oracle, faucet, deploy or other key.
- No key is generated by this change. After the implementation head is ready, Patron (not an
  agent) generates it and keeps it outside `/workspace`, mode 0600. Only the public key and
  keyId enter the repository, by a later PR reviewed by Patron and Security.
- The key is never placed in the gateway, Render, CI, environment variables or logs. The signer
  `t1-sign-summary.mjs --summary <file> --key-file <path>` reads it only from an absolute path to
  a regular non-symlink file owned by the user with mode 0600, outside `/workspace` and the
  repository; it refuses key material on the command line or in the environment and prints
  only `{"keyId","signature"}`.
- Independence is weaker than a separate machine: the signer runs on the same shared machine
  as the office agents, so a compromise of that machine can reach the key file. The live quorum
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
- Tests: CLI tests point the boot at a fixture trust directory through a `node --import` preload
  that sets `globalThis[Symbol.for("zyronchain.open-testnet.test-restore-trust-dir")]`; it is
  not reachable from the environment, command line or network.
