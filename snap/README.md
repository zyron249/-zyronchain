# ZyronChain MetaMask Snap

> **Status: NOT AUDITED · NOT LISTED · TESTNET-ONLY · NO PUBLIC RPC YET.**
> Do not use with real value. This Snap cannot be installed in regular
> MetaMask (it uses a protected, key-management permission and is not on the
> MetaMask allowlist); it runs only in **MetaMask Flask** for development.

A [MetaMask Snap](https://docs.metamask.io/snaps/) that lets MetaMask hold a
ZyronChain account. ZyronChain is a permissioned-BFT L1 (TypeScript, `l1/`), not
an EVM chain: it has its own secp256k1 addresses (`ZYN` + 40 hex) and its own
canonical-JSON transaction format. Supply is fixed at 50,000,000 ZYN and mining
is retired.

The Snap:

- derives one ZyronChain secp256k1 key from the MetaMask Secret Recovery Phrase;
- returns its address, computed exactly like `l1/src/crypto.ts`;
- signs canonical l1 `transfer` transactions **offline** after an explicit
  confirmation dialog, returning the signed transaction in exact l1 format;
- signs domain-separated off-chain messages;
- **never broadcasts** and has **no network access**. There is no public
  ZyronChain RPC endpoint, and none is assumed anywhere in this code.

Built from the official `@metamask/template-snap-monorepo` Snap package layout
(TypeScript, `@metamask/snaps-sdk` 12.0.1, the newest platform version production MetaMask supports, `@metamask/snaps-cli`, `@metamask/snaps-jest`).

## RPC API

All methods are called via `wallet_invokeSnap` from an allowed origin
(`https://zyronchain.com`, or `http://localhost:8000` for development).

### `zyron_getAddress`

No params. Returns:

```json
{ "address": "ZYN…40 hex", "publicKey": "…128 hex (uncompressed, no 04 prefix)", "derivationPath": "m/44'/249249'/0'/0/0" }
```

### `zyron_signTransaction`

Params: `{ "transaction": { … } }` with exactly these fields:

| field | required | rule (mirrors `validateTransactionShape` in l1) |
|---|---|---|
| `kind` | yes | must be `"transfer"`. `"mining_claim"` is **blocked outright**; other l1 kinds (`activity_settlement`, `validator_update`, `protocol_upgrade`) are rejected as unsupported. |
| `version` | yes | `1` or `2`. l1 requires `2` from protocol 3 onward (`2` uses the `zyronchain/transaction/transfer/v2` signing domain). The Snap cannot look this up (no RPC), so the caller must state it. |
| `chainId` | yes | `^[a-z0-9-]{3,64}$` (l1 genesis rule). Shown in the dialog. |
| `nonce` | yes | safe integer ≥ 1 (account nonce + 1; the caller supplies it, there is no RPC). |
| `receiver` | yes | `^ZYN[0-9a-f]{40}$`, not the reserved mining-tracker address. |
| `amountAtoms` | yes | safe integer, 1 … 5,000,000,000,000,000 (1 ZYN = 10^8 atoms). |
| `feeAtoms` | yes | safe integer, 0 … 5·10^15; `amountAtoms + feeAtoms` must not exceed total supply. |
| `timestampMs` | no | safe integer ≥ 0; defaults to the Snap's clock. |
| `sender`, `publicKey` | no | if present, must equal the Snap account. They are always filled from the Snap key. |

Any other field (including a pre-set `signature` or `txid`) is rejected with
JSON-RPC `-32602`. Validation happens **before** the dialog. The dialog shows the
requesting origin, chain ID, full recipient address, amount in ZYN, fee, total,
nonce, tx version and sender. Declining returns `4001`.

Result: `{ "transaction": TransferTx }`, the exact l1 object
(`kind, version, chainId, nonce, sender, receiver, amountAtoms, feeAtoms,
timestampMs, publicKey, signature, txid`). A node operator can submit it
to their own node at `POST <node>/tx`, the same way the l1 CLI `transfer` command does (`submitTransfer` in `l1/src/cli.ts`).
**No public node exists yet.**

### `zyron_signMessage` (optional)

Params: `{ "message": string }` (1–1024 chars; no control or bidi-override characters).
Signs `canonicalJson({ domain: "zyronchain/snap/personal-message/v1", payload: { message, origin } })`
using l1's `signCanonicalDomain` construction, after a dialog. Returns
`{ domain, payload, address, publicKey, signature }`. Verify it with l1's
`verifyCanonicalDomain(domain, payload, signature, publicKey)`.

## Derivation path (provisional)

```
m / 44' / 249249' / 0' / 0 / 0      curve: secp256k1
```

- ZyronChain has **no registered SLIP-44 coin type**. `249249` is a
  **provisional, unregistered** value. It was unassigned in
  [satoshilabs/slips `slip-0044.md`](https://github.com/satoshilabs/slips/blob/master/slip-0044.md)
  at commit `570ed55b` (checked 2026-09-30). Before any release the project
  must either **register a SLIP-44 coin type** (and switch to it) or **formally
  adopt this custom path**. Changing the path changes every derived address, so
  the decision has to be final before users hold funds.
  - Note: the ticker `ZYN` is already used in SLIP-44 by another project
    (Wethio, coin type 77777). A registration would need to use a distinct
    symbol or name the chain explicitly.
- BIP-44 layout (account `0'`, external chain `0`, index `0`) so a future
  multi-account version can extend it without changing account 0.
- The Snap uses `snap_getBip32Entropy` (not `snap_getBip44Entropy`) and the
  manifest grants **exactly this one path**. MetaMask only allows derivation
  under a permitted prefix, so the Snap can derive this key (and its children)
  and nothing else from the SRP. Coin type 60 (Ethereum) is refused by MetaMask
  anyway.
- The address is `"ZYN" + hex(sha256(uncompressedPubKey[1..65]))[0..40]`,
  byte-for-byte the l1 rule (`addressFromPublicKey`).

## Security model

- **Key custody.** The secret key comes from MetaMask (`snap_getBip32Entropy`),
  exists only in the Snap's SES sandbox memory for the duration of one call,
  and the `Uint8Array` is zeroed afterwards (best effort: JS strings returned
  by MetaMask cannot be wiped). It is never returned, logged, stored
  (`snap_manageState` is not requested) or sent anywhere. The tests check that
  no response contains the private key.
- **Key lifetime.** For signing, the Snap validates and shows the dialog using
  public data only, and derives the secret key again only after the user
  approves.
- **Minimal permissions.** `snap_dialog`, `snap_getBip32Entropy` (single path),
  `endowment:rpc` with `allowedOrigins` only (no `dapps: true`, no Snap-to-Snap).
  **No `endowment:network-access`**: signing is fully offline. The origin allowlist is
  enforced again in code.
- **What the user approves.** Every signature needs a `snap_dialog` confirmation
  showing the exact values that get signed. Nothing is signed blind; there is no
  "sign arbitrary hash" method.
- **Strict input.** Exact field set, integer-only atoms, supply-bounded amounts,
  chain-ID format, address format, sender/publicKey binding. `mining_claim` is
  refused before any key access.
- **Canonical parity with l1.** The Snap ports only `canonicalJson`,
  `publicKeyFromPrivate`, `addressFromPublicKey` and `signCanonical(Domain)`
  from `l1/src/{codec,crypto}.ts`, using the same pinned `@noble/curves` 2.3.0
  and options (SHA-256 prehash, RFC 6979 deterministic nonce, low-S, compact
  signature). The Snap verifies its own signature before returning it.
- **Message signing and domain separation.** Messages are signed over
  `canonicalJson({domain, payload})` with domain
  `zyronchain/snap/personal-message/v1`, which differs from every l1 domain.
  A v2 transaction signs `{domain: "zyronchain/transaction/<kind>/v2", …}`, and a v1
  transaction signs the bare tx object (top-level keys `amountAtoms`, `chainId`, …, never
  exactly `{domain, payload}`). The message text is always a string *value*
  inside `payload`, so it cannot change the signed structure. The payload also
  binds the requesting `origin`, so a signature obtained on one site does not
  verify for another. The tests sign a message whose text *is* a canonical
  transfer payload and confirm l1 rejects it as a transaction signature (v1 and v2).
- **Dev-only origin.** `http://localhost:8000` is in the allowlist for
  development. **Remove it before any npm release/listing**, because any local
  process serving that origin could otherwise request signatures, though each
  one still needs user confirmation.
- **Not audited.** Treat everything here as review-pending code.

## Develop (MetaMask Flask)

Requirements: Node ≥ 22, [MetaMask Flask](https://metamask.io/flask/) in a
separate browser profile (never with a real SRP).

```bash
cd snap
npm ci
npm run l1:build          # builds ../l1 (reference implementation used by the tests)
npm test                  # builds the bundle, then runs Jest (@metamask/snaps-jest)
npm start                 # watch + serve the Snap at http://localhost:8080
# in another shell: the demo dapp on the one allowed dev origin
python3 -m http.server 8000 --directory site
```

Open <http://localhost:8000>, click **Connect Snap**, approve the install in
Flask (it shows the requested permissions and the derivation path), then use
**zyron_getAddress** and **zyron_signTransaction**. The page only displays the
signed transaction and never submits it.

`npm run build` rewrites `snap.manifest.json` `source.shasum`. Commit the
updated manifest (CI fails if it is stale).

### Calling the Snap from zyronchain.com (sketch, not deployed)

```js
const SNAP_ID = 'npm:@zyronchain/metamask-snap'; // not published yet; dev: 'local:http://localhost:8080'
await ethereum.request({ method: 'wallet_requestSnaps', params: { [SNAP_ID]: {} } });
const { address } = await ethereum.request({
  method: 'wallet_invokeSnap',
  params: { snapId: SNAP_ID, request: { method: 'zyron_getAddress' } },
});
```

See [`site/app.js`](site/app.js) for the full demo, including EIP-6963 provider
discovery and transfer signing. The live website is intentionally untouched.

## Tests

`npm test` (Jest + `@metamask/snaps-jest`, running the built bundle in the Snaps
simulator). The tests compare against the **real l1 code**: `test/l1-oracle.mjs`
loads the compiled `l1/dist` in a child process.

- `zyron_getAddress` equals the fixed vectors in `test/vectors.json` **and**
  l1's `publicKeyFromPrivate`/`addressFromPublicKey` on the same key (derived
  independently with `@metamask/key-tree`).
- Signed transfers (v1 and v2) are **byte-identical** to l1 `createTransfer`,
  pass l1 `validateTransactionShape`, and are admitted and included in a
  block by a real `ZyronChain` instance (protocol 1 → tx v1; protocol 3 → tx v2).
  A tx signed for one chain ID is rejected by a chain with another.
- Rejections: user declines (4001), `mining_claim` blocked, other kinds, bad
  and missing chain IDs, overflow and malformed amounts (above supply, 2^53, 1e21,
  strings, negatives, fractions, amount+fee above supply), unknown fields,
  pre-set signature/txid, foreign sender/publicKey, bad receiver, disallowed origin.
- Domain separation: message signatures verify with l1 `verifyCanonicalDomain`
  and never as tx signatures, and are bound to the origin.

## Release / listing checklist (all BLOCKED today)

1. **Derivation path decision**: register a SLIP-44 coin type or formally adopt
   `m/44'/249249'/0'/0/0`.
2. **Remove `http://localhost:8000`** from `allowedOrigins` (manifest and
   `src/constants.ts`).
3. **Third-party security audit** by a MetaMask-approved auditor (required for
   any Snap using `snap_getBip32Entropy`). The audit must cover this Snap's
   source and key-management modules, and all medium-or-higher findings must be fixed.
   Provide the audited commit and the fix commit. See the
   [MetaMask Snaps audit wiki](https://github.com/MetaMask/snaps/wiki/Audits).
4. Scan with MetaMask's Snapper tool; remove console logs and TODOs.
5. **Publish to npm** as `@zyronchain/metamask-snap` (versions in `package.json`
   and `snap.manifest.json` must match; correct shasum).
6. **Allowlist**: submit the MetaMask Snaps Directory Information form
   (name must equal `proposedName`, "ZyronChain"; audit report link; support
   contact). It needs at least two approvals from the MetaMask Snaps team. Every new
   version must be re-submitted ([docs](https://docs.metamask.io/snaps/how-to/get-allowlisted/)).
7. **Public network**: a public ZyronChain testnet RPC with nonce/balance
   lookup. Until then, dapps must supply `nonce` and `chainId` themselves and
   broadcast through their own node. The public testnet is currently blocked at
   the activation gate (see `docs/STANDALONE_L1_READINESS.md`).
8. Only then integrate into zyronchain.com (switch from Flask to regular MetaMask).
