# Feature 6A: shared fail-closed intent renderer (design)

Status: **design proposal, awaiting Security review. No code until approved.**
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
| `version` | `2` (v1 is refused, see open question 1) |
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
2. `remote-signer-service.ts`: no transfer intent exists. The core PR adds no new
   intent; it adds a guard so a future transfer intent must go through
   `renderIntent`. Validator consensus intents keep their existing validators.
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

## 10. Open questions

1. `createTransfer` defaults to `version = 1` (no signing domain). Should the
   renderer refuse v1 (proposed), or render it with a "legacy, no domain" line?
2. Amounts are `number`, not BigInt, in `types.ts`. The renderer converts with
   `BigInt()` after safe-integer checks; is that sufficient, or should 6B move to
   string atoms?
3. Snap does not show `timestampMs` and `publicKey`; the PWA should be checked too.
   Showing all fields may need a collapsed "details" section; is that acceptable as
   "rendered"?
4. Snap computes `Total` with `number` addition; move it to the shared formatter.
5. Should the CLI `--yes` flag exist at all for transfers?
6. Should the remote signer ever sign transfers? Proposed: not in 6A.

## 11. Timeline

- Design to Security: Oct 27, 18:00 ET.
- Core PR (module, vectors, CLI, signer guard): Oct 30, after design approval.
- Wallet Dev PR (PWA + Snap parity): after the core PR merges.
