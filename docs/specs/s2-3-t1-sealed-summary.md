# S2-3 trust anchor T1: externally sealed restore summary

Status: specification for the open-testnet restore anchor (finding S2-3, option T1).
Scope: open-testnet backups only. Nothing here applies to mainnet, to value-bearing
networks, to supply or allocation tables, or to activation flags.

## 1. Problem

`restoreNetwork` (`l1/scripts/open-testnet.mjs`) checked the snapshot format, the chain ID,
the genesis hash, the keys against genesis, and a full block replay. It did not check the
restored state against anything independent of the snapshot. A correctly sealed snapshot of
an abandoned or stale branch could therefore be restored as if it were current. A summary
read from the same snapshot does not help: it is as stale as the snapshot.

T1 closes this with an expected summary that is built from a live quorum of validators,
signed by a dedicated testnet-only key that is never used for anything else, and checked by
every restore before the network directory is marked complete.

## 2. Summary content

A summary has exactly these fields (no others are accepted):

| Field | Type | Meaning |
|---|---|---|
| `version` | integer, `1` | Summary encoding version |
| `chainId` | string | Open-testnet chain ID (must contain `testnet`, never `mainnet`) |
| `genesisHash` | 64 hex | Genesis hash of the chain (network / genesis identity) |
| `height` | integer >= 1 | Height of the summarized tip |
| `tipHash` | 64 hex | Block hash at `height` |
| `stateRoot` | 64 hex | `header.stateRoot` of the block at `height` |
| `totalSupplyAtoms` | decimal string | Genesis total supply (fixed; nothing mints) |
| `burnedAtoms` | decimal string | `totalSupplyAtoms - sum(balances)` at `height` |
| `validatorSetHash` | 64 hex | Hash of the validator set that governs `height + 1` |
| `oracleSetHash` | 64 hex | Hash of the activity-oracle set that governs `height + 1` |
| `timestampMs` | integer >= 0 | When the summary was built (milliseconds since the epoch) |
| `sequence` | integer >= 1 | Strictly increasing per chain; set by the operator who builds it |
| `keyId` | 32 hex | Identifier of the signing key (section 4) |

Set hashes (lowercase hex SHA-256 of canonical JSON, `l1/src/codec.ts` `canonicalJson`):

- `validatorSetHash = SHA-256(canonicalJson({ domain: "zyronchain/s2-3/t1-validator-set", version: 1, validators: [{ address, publicKey }, ...] }))`, in the chain's validator order.
- `oracleSetHash = SHA-256(canonicalJson({ domain: "zyronchain/s2-3/t1-oracle-set", version: 1, set }))`, where `set` is the activity-oracle set the chain applies at `height + 1` (oracle keys in genesis order, threshold, policy, cap, launch profile, genesis timestamp, pause state, and the revoked keys sorted).

Order and membership both change the hash, so a reordered or substituted set is a mismatch.

## 3. Signature and canonical encoding

Requirement 1: the signature is **Ed25519** over a **domain-separated** message with a fixed
domain tag and a versioned canonical encoding that covers **every** summary field **and** the
`keyId`.

Message bytes (UTF-8, `\n` is a single 0x0A byte, no trailing spaces):

```
zyronchain/s2-3/t1-sealed-summary\n
encoding=1\n
version=<version>\n
chainId=<chainId>\n
genesisHash=<genesisHash>\n
height=<height>\n
tipHash=<tipHash>\n
stateRoot=<stateRoot>\n
totalSupplyAtoms=<totalSupplyAtoms>\n
burnedAtoms=<burnedAtoms>\n
validatorSetHash=<validatorSetHash>\n
oracleSetHash=<oracleSetHash>\n
timestampMs=<timestampMs>\n
sequence=<sequence>\n
keyId=<keyId>\n
```

- The field order is fixed. Integers are written in decimal without leading zeros or signs.
- Every value is validated against a strict pattern before encoding (lowercase hex of the exact
  length, decimal digits, chain-ID characters `[a-z0-9-]`), so no value can contain `\n` or `=`
  and the encoding is unambiguous.
- A future change to the field set or the encoding gets a new `encoding=` number; a verifier
  rejects any encoding it does not know.
- The summary digest used by the superseded record is `SHA-256(message bytes)`, lowercase hex.
- The published envelope is
  `{ "format": "zyronchain-t1-sealed-summary-v1", "summary": { ... }, "signature": "<128 hex>" }`.
  Unknown envelope or summary fields are rejected.

Implementation: `l1/src/sealed-summary.ts` (`sealedSummaryMessage`, `verifySealedSummary`).

## 4. Keys and key identifiers

Requirement 6: the key is **single-purpose** and **testnet-only**. It is never reused from,
derived from, or shared with any validator, oracle, faucet, founder, deploy or other key, and it
signs nothing except T1 summaries.

- Algorithm: Ed25519. The private key is a PKCS#8 PEM file; the public key is pinned as the raw
  32-byte key in lowercase hex.
- `keyId = first 16 bytes of SHA-256("zyronchain/s2-3/t1-key-id\n" || raw public key)`, 32 hex.
- Pinned keys live in `l1/trust/t1-summary-keys.json`:

  ```json
  { "format": "zyronchain-t1-summary-keys-v1", "networkClass": "testnet", "purpose": "t1-sealed-summary", "keys": [] }
  ```

  Each entry is `{ "keyId", "publicKey", "addedIn" }`; `keyId` must equal the value derived from
  `publicKey`. The file starts with an **empty** `keys` list. With no pinned key every restore
  fails with `anchor_missing`. That is intended until a key is pinned.
- Only the public key and the keyId ever go into the repository, by a later PR with Patron and
  Security review.

## 5. Where the summary comes from

Requirement 2: the summary is built from a **live quorum tip match**, never from the snapshot
being restored.

- Input to the builder (`buildSealedSummaryFromQuorum`, CLI `l1/scripts/t1-build-summary.mjs`)
  is a list of observations, one per validator, each read from that validator's own live state:
  `{ validator, origin: "live-quorum", height, tipHash, stateRoot, totalSupplyAtoms, burnedAtoms,
  validatorSetHash, oracleSetHash }`, plus the validator set (address and public key) those
  observations claim.
- The builder refuses: any observation whose `origin` is not `live-quorum` (in particular
  `snapshot`); observations from keys outside the claimed set, or duplicates; a claimed set
  whose hash differs from the agreed `validatorSetHash`; and fewer than
  `floor(2n/3) + 1` validators (n = set size) agreeing on **every** field at one height.
- The builder never reads a snapshot. A summary is produced for the height of the snapshot it
  will accompany, at the time that snapshot is published, from validators that are live and in
  agreement at that height.

## 6. Restore-time check

`restoreNetwork(dir, bundle, chainId, { anchor })` fails closed. Before any file is written:

1. Load the pinned keys and the record (section 7). A malformed file or a broken record chain
   rejects with `anchor_record_invalid`.
2. Verify the envelope (codes in section 8, in this order): missing, malformed, signed by a
   chain key, unknown keyId, revoked keyId, bad signature, superseded, lower height.
3. The summary `chainId` and `genesisHash` must equal the bundle's, else `anchor_state_mismatch`.

After the replay and the byte-for-byte checks of every validator copy, and before
`network.json` (the completion marker) is written:

4. The replayed chain's `height`, `tipHash`, `stateRoot`, `totalSupplyAtoms`, `burnedAtoms`,
   `validatorSetHash` and `oracleSetHash` must all equal the summary, else
   `anchor_state_mismatch` naming the fields. A stale snapshot (lower than the summary) or an
   abandoned branch (other tip or state) therefore never gets a completion marker, and the
   start-up stops without creating a fresh genesis.

There is no fallback: no option turns the check off, and the summary inside a snapshot (if any)
is never consulted.

The CLI (`open-testnet.mjs run --init-if-missing`) reads the envelope from
`--restore-summary <file or https URL>` or `ZYRON_TESTNET_RESTORE_SUMMARY`. A summary that is
missing or cannot be fetched is `anchor_missing`. `--t1-trust-dir <dir>` replaces the pinned
key and record files; it exists for local tests and disposable networks only, logs a warning,
and the hosted start command must never pass it (a test checks the deploy profile).

## 7. Rotation, revocation and the append-only record

Requirement 5: rotation and revocation happen **only by PR** with Patron and Security review,
through an **append-only** record, `l1/trust/t1-summary-record.json`:

```json
{ "format": "zyronchain-t1-summary-record-v1", "entries": [] }
```

Entry kinds (every entry also has `index`, starting at 1, and `prev`, the SHA-256 of the
canonical JSON of the previous entry, or 64 zeros for the first):

- `{ "kind": "revoke-key", "keyId", "reason" }`: the key is revoked; summaries with this keyId are
  rejected even if the key is still pinned.
- `{ "kind": "supersede-summary", "chainId", "summaryDigest"?, "height"?, "tipHash"?, "reason" }`:
  a specific summary (by digest) or a specific tip (`height` + `tipHash`) is superseded, for
  example after a rollback; it is rejected from then on.
- `{ "kind": "floor", "chainId", "minHeight", "minSequence", "reason" }`: summaries for this
  chain below either value are rejected as replays.

Rules:

- Entries are only appended. Editing, reordering or deleting an entry breaks the `index`/`prev`
  chain and every restore fails with `anchor_record_invalid` until it is fixed by PR.
- Rotation: (1) Patron generates a new key (section 9); (2) a PR adds the new public key and
  keyId to `t1-summary-keys.json` and appends a `revoke-key` entry for the old keyId plus a
  `floor` entry at the current height and next sequence; (3) Security reviews the exact head;
  (4) Patron merges; (5) the next published snapshot gets a summary signed by the new key.
- A revoked key stays listed in the record forever, so it cannot be silently re-pinned.

### Compromise runbook

If the private key is suspected exposed (found in a log, repository, chat, environment, CI, or
any file other than its custody path, or the custody machine is compromised):

1. Stop signing. Treat every summary signed after the last known-good time as untrusted.
2. Open a PR that appends `revoke-key` for the keyId and a `floor` at the highest verified live
   height and the next sequence, and removes the key from the pinned list. Restores fail closed
   with `anchor_revoked_key` (or `anchor_missing` once no key is pinned) until a new key lands;
   that outage is accepted.
3. Patron generates a new key (section 9) on a clean host, never from or near the old key.
4. A second PR pins the new public key. Security reviews the exact head; Patron merges.
5. Rebuild a summary from a live quorum at the current height and sign it with the new key;
   append `supersede-summary` entries for any summary or tip signed during the exposure window.
6. Record the incident (time found, exposure window, keyIds) in the PR descriptions. Never paste
   key material anywhere, including into the incident record.

## 8. Rejection codes

Requirement 4: every rejection is fail-closed and has its own code
(`SealedSummaryError.code`, exported as `T1_REJECTION_CODES`).

| Code | When | Test (`l1/test/s2-3-t1-sealed-summary.test.ts`) |
|---|---|---|
| `anchor_missing` | No envelope, no pinned key (the shipped placeholder), or the summary cannot be fetched | `anchor_missing: ...` (unit, pinned placeholder, restore) |
| `anchor_tampered_field` | The Ed25519 signature does not verify over the canonical message, i.e. any signed field was changed | `anchor_tampered_field: every summary field ...` |
| `anchor_wrong_key_id` | `keyId` is not a pinned key | `anchor_wrong_key_id: ...` |
| `anchor_revoked_key` | `keyId` has a `revoke-key` record entry | `anchor_revoked_key: ...` |
| `anchor_superseded_summary` | The summary digest or its tip has a `supersede-summary` entry | `anchor_superseded_summary: ...` |
| `anchor_lower_height_replay` | Height or sequence below a `floor` entry, or below the caller's known minimum | `anchor_lower_height_replay: ...` |
| `anchor_validator_key_signature` | The signature verifies under a validator, oracle or other chain key of the bundle (secp256k1), or `keyId` is derived from one | `anchor_validator_key_signature: ...` |

Supporting codes (also fail-closed):

| Code | When |
|---|---|
| `anchor_malformed` | Envelope or summary is not exactly the schema above |
| `anchor_record_invalid` | Pinned key file or record malformed, keyId does not match its public key, or the record chain is broken |
| `anchor_state_mismatch` | A verified summary disagrees with the bundle's chain/genesis or with the replayed state |

## 9. Custody

- Requirement 3: the private key is **never** present in the gateway, on Render or any host
  that runs the open testnet, in CI, in environment variables, in logs, in chat, or in the
  repository. Only the restore *verifier* runs on those hosts, and it needs only the public key.
- Patron, not an automation agent, generates and holds the key, after the implementation head
  is ready (not before). The key file is stored outside `/workspace` with mode `0600`.
- The signer (`l1/scripts/t1-sign-summary.mjs --summary <file> --key-file <path>`) reads the
  key only from that path, refuses a key file that is not a regular file, is readable by group
  or other, lies inside the repository checkout or under `/workspace`, or is not Ed25519, and
  prints **only** `{ "keyId": "...", "signature": "..." }`. It never prints, logs or writes the
  key, and its error messages never include key material.
- **Independence is weaker than a separate machine.** The signer runs on the same shared machine
  as the office agents, which also hold repository access. An agent or process on that machine
  that can read the key file could sign an arbitrary summary. File permissions, the
  outside-`/workspace` path, the single-purpose key and PR-only rotation reduce this risk but do
  not remove it. A later step can move signing to a separate machine or hardware key without
  changing the format.

## 10. Non-claims

- T1 does not authenticate snapshot downloads (S2-7 is separate).
- It does not prove that a free host persists data, or that a restored network is current
  beyond the signed height.
- Passing restore tests with runtime-generated fixture keys does not mean a real key exists.
  No key is generated or committed by this change.
