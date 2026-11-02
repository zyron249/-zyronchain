# Offline send-check CLI

`send-check` runs the advisory send-safety warnings (feature 7) for a planned transfer before you
sign it. It uses the same warning logic as the PWA wallet (`l1/src/send-warnings.ts`, a port of
`sendWarnings` / `lookalikeMatches` in `website/app/zyron-wallet-core.js`, kept aligned by a parity
test). Added in #1141; self-send normalization and the truncation note were added in #1143.

## Offline and advisory

- **Offline.** The command makes no network calls and reads no chain state. The only input besides
  the flags is the optional `--known-file`, which is read locally and never sent to a node.
- **Advisory, not consensus.** The warnings never change consensus, block validity, mempool
  admission, genesis, supply or keys. A transaction that triggers a warning is still valid if it is
  otherwise valid. The only blocking case is self-send, which the chain already rejects.

## Usage

Build `l1` first (`npm ci && npm run build` in `l1/`), then:

```sh
node dist/src/cli.js send-check --to <ZYN...> [--from <ZYN...>] [--amount-atoms N] [--known-file book.json] [--format text|json]
```

| Flag | Required | Meaning |
| --- | --- | --- |
| `--to` | yes | Receiver address. The canonical lower-case form and the mixed-case checksum form are both accepted. |
| `--from` | no | Your own address. Needed for the self-send check. It is normalized the same way as `--to`, so a checksummed or differently cased copy of the same address still matches. |
| `--amount-atoms` | no | Amount in atoms (1 ZYN = 100,000,000 atoms). Needed for the large-amount check. |
| `--known-file` | no | JSON file with your contacts, send history and threshold (see below). Without it the book is empty. |
| `--format` | no | `text` (default) or `json`. Any other value fails. |

Any other flag is rejected.

### Known-address file

```json
{"contacts":[{"name":"Alice","address":"ZYN..."}],"sent":["ZYN..."],"thresholdAtoms":null}
```

The file is validated strictly and the command fails if anything is off:

- The top level must have exactly the keys `contacts`, `sent` and `thresholdAtoms`.
- The file may be at most 65,536 bytes.
- `contacts`: at most 100 entries, each with exactly `name` and `address`. Names must be 1 to 64
  characters, with no control characters and already whitespace-normalized. Addresses must be
  canonical (`ZYN` followed by 40 lower-case hex characters) and unique.
- `sent`: at most 200 unique canonical addresses.
- `thresholdAtoms`: `null` (no large-amount check) or an integer from 1 up to the fixed supply in atoms.

## Warnings

| Code | Blocking | When it fires |
| --- | --- | --- |
| `self` | **yes** | `--to` equals `--from`. When this fires, no other checks run. Message: "You can't send to your own address. Enter a different recipient." |
| `lookalike` | no | A known address that is *not* the receiver either shares at least 6 hex characters across its start plus end with the receiver (the prefix and suffix never overlap), or differs in at most 2 hex positions. This is the pattern used in address-poisoning scams. Up to 3 matches are reported, contacts first and then history. |
| `first-time` | no | The receiver is not in `sent`. The message says whether it is a saved contact. |
| `large-amount` | no | `thresholdAtoms` is set, `--amount-atoms` is given, and the amount is at or above the threshold. |

If no warnings fire, text mode prints "No send warnings. Still compare every character of the address."

## Truncation

At most 250 known addresses (contacts first, then history, with duplicates removed) are compared for
lookalikes. A full book can hold up to 300 (100 contacts and 200 sent). If the book has more than
250, text output says how many were compared:

```
note: only the first 250 of 300 known addresses were compared for lookalikes
```

The JSON output does not include this note. Lookalike matching also stops after 3 matches.

## Output and exit codes

- Text mode prints the receiver as a checksummed address in 4-character groups, then one
  `WARNING (<code>[, blocking])` line per warning. For `lookalike`, it also prints each matching known
  address and the hex positions (0 to 39) where it differs.
- JSON mode prints `{receiver, display, advisory: true, warnings}`. Each warning has `code`,
  `blocking` and `message`. Lookalike warnings also carry their `matches`.

| Exit code | Meaning |
| --- | --- |
| 0 | Checks ran. Non-blocking warnings may have been printed. |
| 1 | A blocking `self` warning, or an error such as an invalid address, a bad known-file, or a bad `--format`. The CLI prints `Fatal: <message>` on stderr. For `self`, the warnings are printed first (in either format). |
| 2 | No command or an unknown command (prints the usage). |

## Examples (from a local run)

These use placeholder addresses. `book.json` holds the contact `Alice`
(`ZYNaaaa00000000000000000000000000000000aaaa`), one sent address
(`ZYN1111111111111111111111111111111111111111`) and `"thresholdAtoms":100000000000`.

First-time recipient, with no book:

```
$ node dist/src/cli.js send-check --to ZYN1111111111111111111111111111111111111111
Receiver (checksummed, grouped): ZYN 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111
WARNING (first-time): You have never sent to this address from this wallet, and it is not in your address book. Check every character of the address.
# exit 0
```

Lookalike, first-time and large-amount together:

```
$ node dist/src/cli.js send-check --to ZYNaaaa00000000000000000000000000000000aaab --amount-atoms 100000000000 --known-file book.json
Receiver (checksummed, grouped): ZYN Aaaa 0000 0000 0000 0000 0000 0000 0000 0000 aaAb
WARNING (lookalike): This address looks like your saved contact "Alice" but it is a DIFFERENT address. Scammers create lookalike addresses with the same start and end. Compare every character.
  known (contact "Alice"): ZYN aaAA 0000 0000 0000 0000 0000 0000 0000 0000 aaaa
  differs at hex positions: 39
WARNING (first-time): You have never sent to this address from this wallet, and it is not in your address book. Check every character of the address.
WARNING (large-amount): The amount (1000 ZYN) is at or above your warning threshold of 1000 ZYN.
# exit 0
```

Self-send (blocking):

```
$ node dist/src/cli.js send-check --to ZYN2222222222222222222222222222222222222222 --from ZYN2222222222222222222222222222222222222222
Receiver (checksummed, grouped): ZYN 2222 2222 2222 2222 2222 2222 2222 2222 2222 2222
WARNING (self, blocking): You can't send to your own address. Enter a different recipient.
Fatal: You can't send to your own address. Enter a different recipient.
# exit 1
```

JSON output for a known recipient:

```
$ node dist/src/cli.js send-check --to ZYN1111111111111111111111111111111111111111 --known-file book.json --format json
{
  "receiver": "ZYN1111111111111111111111111111111111111111",
  "display": "ZYN 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111",
  "advisory": true,
  "warnings": []
}
# exit 0
```

Truncation, with a book of 100 contacts and 200 sent addresses:

```
$ node dist/src/cli.js send-check --to ZYNffffffffffffffffffffffffffffffffffffffff --known-file big.json
Receiver (checksummed, grouped): ZYN FfFF FfFF fFfF fffF FFfF ffFF Ffff FFfF fFfF FfFf
note: only the first 250 of 300 known addresses were compared for lookalikes
WARNING (first-time): You have never sent to this address from this wallet, and it is not in your address book. Check every character of the address.
# exit 0
```

Bad format:

```
$ node dist/src/cli.js send-check --to ZYN1111111111111111111111111111111111111111 --format xml
Fatal: --format must be text or json
# exit 1
```
