# Feature 6A: shared fail-closed intent renderer (design)

Status: **design approved by Security subject to the required conditions in section 10.**
Parent document: section 3 of `docs/design/differentiating-features.md` (PR #1126).
Consensus impact: **none**. Ships with the wallet and signer tooling only.

## 1. Goal

Before any key signs a transaction, every signer (CLI, PWA wallet, Snap, and any
future remote transfer signer) shows the user the same complete, deterministic
description of exactly what is signed, and refuses to sign anything it cannot
describe completely.

## 2. What exists today (from the code)

- `l1/src/types.ts` `TransferTx`: `kind, version, chainId, nonce, sender, receiver,
  amountAtoms, feeAtoms, timestampMs, publicKey, signature, txid`. Amounts are JS
  `number` (safe integers), not BigInt.
- `l1/src/transaction.ts`: the signed object is the unsigned transfer, i.e. the tx
  minus `signature` and `txid` (`txSigningPayload`). For `version: 2` it is signed as
  `canonicalJson({ domain: "zyronchain/transaction/transfer/v2", payload })`
  (`signCanonicalDomain` in `crypto.ts`); for `version: 1` the bare payload is signed
  without a domain. `txid = sha256(canonicalJson({...unsigned, signature}))`.
- So the exact v2 signed field set for a transfer is the 10 keys:
  `amountAtoms, chainId, feeAtoms, kind, nonce, publicKey, receiver, sender,
  timestampMs, version`, plus the domain string.
- `website/app/zyron-wallet-core.js`: `describeTransfer` already enforces exactly
  these 10 keys (`TRANSFER_KEYS`), transfer-only, version 1|2, testnet chain IDs;
  `signTransfer` self-verifies the signature.
- `snap/src/ui.tsx` + `snap/src/zyron/transfer.ts`: Snap mirrors l1 validation and
  renders chainId, receiver, amount, fee, total, nonce, version and sender.
  It does not render `timestampMs` or `publicKey`.
- `l1/src/cli.ts`: the transfer command builds and signs with `createTransfer`
  directly from flags; nothing is rendered or confirmed before signing.
- `l1/src/remote-signer-service.ts`: validator-consensus intents only
  (`KNOWN_INTENTS` = block-proposal, block-attestation, round-skip,
  consensus-proposal, prepare-vote, commit-vote, round-timeout). It never signs
  transfers today and already refuses unknown intents and extra keys.

## 3. Module: `l1/src/intent-render.ts`

- `export const RENDERER_VERSION = 1`.
- Pure: no I/O, no clock, no randomness, no globals. Locale-free: no `Intl`,
  no `toLocaleString`, no floating point. Integer/BigInt-only arithmetic.
- API (sketch):
  ```ts
  renderIntent(input: { domain: string; payload: unknown }): RenderedIntent
  // RenderedIntent = { rendererVersion: 1; kind: "transfer";
  //   lines: readonly { label: string; value: string }[]; text: string }
  assertRenderMatchesSigningBytes(rendered, signingBytes: Uint8Array): void
  ```
  Throws `IntentRenderRefusal` on any failure; callers must treat that as
  "do not sign".
- `text` is the lines joined as `label: value\n`, ASCII only, so it can be hashed
  later (6B).

### 3.1 Kind allowlist

Version 1 allows only `kind: "transfer"` with domain
`zyronchain/transaction/transfer/v2`. Per #1126 default (6), stake/unstake and
delayed-send/cancel are added only when each kind exists, each with a renderer
version bump. Everything else is refused (activity settlement, mining claim,
validator update, oracle governance, protocol upgrade, messages, arbitrary JSON).

### 3.2 Transfer field table (every signed field is rendered)

| Field | Rendered as |
|---|---|
| `kind` | `Transfer` |
| `version` | `2` (v1 is refused, see resolved question 1) |
| `chainId` | verbatim; must match the chain ID regex |
| `sender` | checksummed address (`toChecksumAddress`, ZMC-1) |
| `receiver` | checksummed address |
| `amountAtoms` | `<ZYN> ZYN (<atoms> atoms)`, e.g. `1.5 ZYN (150000000 atoms)` |
| `feeAtoms` | same format |
| total | derived line `amount + fee`, BigInt sum, same format (display only) |
| `nonce` | decimal integer |
| `timestampMs` | decimal integer ms plus ISO-8601 UTC computed by integer math |
| `publicKey` | full hex |
| domain | verbatim domain string |

ZYN formatting: `ATOMS_PER_ZYN = 100_000_000`; integer part and 8-digit fraction
via BigInt division and modulo, trailing zeros trimmed, no thousands separators.

### 3.3 Fail-closed rules (all mean refuse to sign)

- Unknown `kind`, or a domain that does not equal `transactionSigningDomain(kind)`.
- Missing, unknown or extra field (exact key set), or a wrong type.
- Non-safe-integer or negative amounts/fee/nonce/timestamp; zero amount.
- Any string containing non-ASCII, control (U+0000-U+001F, U+007F) or bidi
  characters (U+200E/F, U+202A-U+202E, U+2066-U+2069); addresses failing checksum
  parsing (`parseAddressInput`) or reserved addresses.
- Mismatch: the renderer re-parses every value from the rendered lines back into a
  payload, rebuilds `canonicalJson({domain, payload})`, and requires byte equality
  with the bytes the caller is about to sign.

## 4. Golden vectors: `l1/test/vectors/intent-render-v1.json`

Generated from l1 and committed. Each case: `{ name, domain, payload,
signingBytesHex, expected: { lines, text } | { refusal } }`. Valid cases cover
min/max safe amounts, 1 atom, whole ZYN, zero fee, fee floor, mixed-case input
addresses. Refusal cases cover every rule in 3.3. Every valid case asserts a
round-trip: parse `amountAtoms`/`feeAtoms` back from the rendered text and get the
exact integers. The same file is consumed by the PWA and Snap tests.

## 5. Integration points

1. CLI signer (`cli.ts` transfer): render, print, require confirmation
   (or `--yes` for scripts, still rendered to stderr), then sign. Core PR.
2. `remote-signer-service.ts`: no transfer intent exists, and 6A adds none. A
   test fails if a transfer-named intent is added without `renderIntent`. Validator consensus intents keep their existing validators.
3. PWA (`zyron-wallet-core.js`) and Snap: separate Wallet Dev PR, using the same
   vectors; `describeTransfer` and Snap `ui.tsx` take their rows from the vectors'
   format. Parity test as for send warnings.

## 6. Threat model

- Renderer hides or mis-formats a field: exact-key rule plus vector coverage of all
  fields.
- Homoglyph/bidi/control text: ASCII-only rule; checksummed addresses.
- Display/bytes mismatch: round-trip to signing bytes before signing.
- Version drift between signers: `RENDERER_VERSION` in output; shared vectors;
  parity tests fail CI on drift.
- Floating-point or locale drift: BigInt only, no `Intl`.
- Out of scope: a compromised host that changes both the display and the bytes
  (needs a hardware display); 6B adds consensus binding.

## 7. Test plan

Fail-first unit tests per refusal rule; vector tests in l1, PWA and Snap; a
property test (random valid transfers round-trip); a CLI test that signing does not
happen when rendering refuses; existing transfer and remote-signer suites unchanged.

## 8. Rollout

No consensus change, no genesis change, no activation flag. Ships with the CLI and
wallet releases. Testnet first. The core PR touches `l1/src`, so it changes the
supply-verifier pin and is batched per the interim pin policy.

## 9. Relation to 6B

6B (payload v3 with `intentHash`) will hash `text` + `RENDERER_VERSION`. 6A is
therefore built byte-exact from day one, but 6A itself is advisory and not
consensus-critical.

## 10. Required conditions (Security approval)

- **R1 Single signing path.** `signTransfer`/`createTransfer` take the
  `RenderedIntent` (or its rebuilt bytes) and sign only those. There is no path where
  a caller passes its own payload after rendering.
- **R2 Canonical input only.** The payload must carry the exact canonical address
  string. A non-canonical (mixed-case) address in the payload is refused, never
  normalized. Normalization happens only at user input, before the payload is built.
  The mixed-case vectors test refusal.
- **R3 chainId allowlist.** Only the known testnet chain IDs, matching the PWA's
  `describeTransfer`. Mainnet IDs are added only on the owner's mainnet activation,
  with a renderer version bump.
- **R4 publicKey binding.** Before signing, the signer checks that the payload's
  `publicKey` equals its own key and that `sender` is derived from it.

## 11. Resolved questions

1. **v1 refused.** The same core PR switches the CLI and PWA transfer defaults to
   v2. A later, activation-gated consensus deprecation of v1 is future work only.
2. **Number amounts are acceptable.** Each value is checked with
   `Number.isSafeInteger` before `BigInt()`, and the total is computed in BigInt.
   String atoms come with 6B.
3. **Collapsing.** Only `publicKey`, `timestampMs` and the domain may be collapsed
   into a details section, and only together with R4. Kind, chainId, sender,
   receiver, amount, fee, total and nonce are on the first screen, covered by a Snap
   UI test.
4. **Snap total** uses the shared BigInt formatter.
5. **`--yes` stays.** It still prints the full render to stderr and can never be
   enabled by env or config. Optional `--expect-receiver` and `--expect-amount`
   flags add a fail-closed check.
6. **No transfers in `remote-signer-service`.** A test fails if a transfer-named
   intent is added without `renderIntent`.

## 12. Timeline

- Design to Security: Oct 27, 18:00 ET.
- Core PR (module, vectors, CLI, signer guard): Oct 30, after design approval.
- Wallet Dev PR (PWA + Snap parity): after the core PR merges.

## 13. Transaction version selection (option 3) and the v1 ruling

Patron chose option 3 for PR #1146: the transaction version comes from the chain's
advertised protocol, never from a flag, a toggle or the payload.

- **Online (`zyron-l1 transfer`)**: the CLI reads `GET /protocol` and uses the ACTIVE protocol `currentVersion` (not `nextVersion`)
  (404 means protocol 1). See `l1/src/cli.ts` `advertisedProtocolForRpc` and
  `submitTransfer` (`resolveTransferVersion(chainId, …, "node")`). There is no version flag.
- **Offline (`zyron-l1 transfer-sign`)**: the version comes from a fixed, frozen
  chainId-to-protocol table in `l1/src/transfer-version-policy.ts`
  (`OFFLINE_CHAIN_PROTOCOLS`: `zyron-wallet-testnet-1` = 1, `zyron-open-testnet-1` = 6).
  An unknown chain is treated as v2-capable (protocol 3), never as v1. `--tx-version` only
  confirms; a value that disagrees with the table is refused.
- **Consensus is unchanged**: protocol < 3 needs tx v1, protocol >= 3 needs tx v2.

### Security ruling: v1 is never signed by the CLI or the renderer path

`resolveTransferVersion` refuses every protocol < 3 chain with an error pointing to
issue #1147. `l1` `signTransfer` refuses version 1 on every chain ID. The CLI therefore
cannot sign for `zyron-wallet-testnet-1` (protocol 1) or the local v1 devnet.

**PWA-only, time-boxed v1 exception.** `website/app/zyron-wallet-core.js` still signs v1,
but only for `zyron-wallet-testnet-1` and only while the transaction `timestampMs` is before
`V1_EXCEPTION_END_MS = 1794096000000` (2026-11-08T00:00:00Z). Anything else fails closed.
It is also refused when `Date.now()` is at or after the end (so a backdated `timestampMs` cannot extend it), when the device clock is unreadable, and when `timestampMs` is more than `V1_CLOCK_WINDOW_MS = 600000` (10 minutes) from `Date.now()`. The exception is hard-coded (not env- or config-driven) and ends when testnet-1 reaches
protocol 3 (#1147), whichever comes first.

### R3: fixed chain ID list

Only `zyron-devnet-1`, `zyron-wallet-testnet-1` and `zyron-open-testnet-1` are rendered and
signed, in l1 and the PWA (identical lists, enforced by a test). Everything else, including
any ID containing "mainnet" and bare "testnet", is refused. `zyron-public-testnet-1` is not in
the list.

### Known gaps

1. An online node can lie about its protocol. Lying *downward* now only causes a refusal;
   lying *upward* produces a v2 transaction that a protocol-1 chain rejects. Neither path
   signs v1.
2. The PWA chooses the version per chain ID, not from `/protocol`. Making it
   protocol-driven needs UI changes (`app.js` and the `index.html` version select), which
   belong to Wallet Dev.
3. `zyron-open-testnet-1` runs protocol 1 until its v6 activation height; during those
   bootstrap heights CLI transfers are refused.
4. `npm run devnet:check:v1-legacy` (protocol 1) fails by design at its transfer step, because
   `l1/scripts/local-devnet.mjs` uses the CLI `transfer` (wallet path). It is not weakened;
   #1147 moves the local devnet to protocol 3. `npm run devnet:check` now runs the v6 devnet (alias `devnet:check:v6`) on `zyron-devnet-1`.

Follow-up: https://github.com/zyron249/-zyronchain/issues/1147
