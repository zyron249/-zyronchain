# ZyronChain display-only address checksum (ZMC-1)

Status: display and input-validation convention. **Consensus is unchanged.**

## Canonical (consensus) form

`ZYN` + 40 lower-case hex characters = the first 20 bytes of SHA-256 over the 64-byte
uncompressed secp256k1 public key (x‖y). This is the only form that appears in transactions,
genesis files, state and RPC responses. It carries no checksum.

## Checksummed display form

Adapted from Ethereum's EIP-55, using SHA-256 and a domain tag:

1. Start from the canonical address `A` (`ZYN` + 40 lower-case hex).
2. `H = SHA-256(UTF-8("zyronchain/address-checksum/v1:" + A))`, as 64 lower-case hex characters.
3. For each body position `i` (0..39): if the character is a letter `a`-`f` and hex digit `H[i]`
   is `8`-`f`, write it upper-case; otherwise keep it as is. The `ZYN` prefix stays upper-case.

Lower-casing the 40-character body of a checksummed address always gives back `A`.

## Validation rules (wallets, CLI, website)

| Input | Result |
|---|---|
| `ZYN` + 40 lower-case hex | Valid plain form. No checksum to verify; ask the sender for the checksummed form or compare carefully. |
| `ZYN` + mixed-case hex equal to the checksummed form | Valid, checksum verified. |
| Any other mixed or upper case | Rejected: checksum mismatch (likely a typo). |
| Anything else | Rejected: malformed. |

Tools must convert to the canonical lower-case form before signing or submitting anything.

Strength: each letter contributes one check bit (about 15 on average), so a random typo in a
checksummed address slips through with probability about 2^-15. Addresses with no letters at all
(astronomically rare) gain no protection.

## Test vectors

| Canonical | Checksummed |
|---|---|
| `ZYN09c0b2d1a486c439a87bcba6b46a7a1a23f3897c` | `ZYN09C0B2D1A486C439A87bCbA6b46A7a1A23F3897c` |
| `ZYN5d99ee966b42cd8fc7bdd1364b389153a9e78b42` | `ZYN5D99EE966b42cD8fC7bdD1364B389153A9E78B42` |
| `ZYN8fb16cd1fbcedbd367eb258df0a7c40b7225c87a` | `ZYN8fB16Cd1FbCEDBd367Eb258Df0A7c40b7225C87A` |
| `ZYN5cb032e51cee3b6ba053648fcdb806aaabf92df6` | `ZYN5cB032e51Cee3b6Ba053648FcDb806aaaBF92Df6` |
| `ZYN80636eaa7a0a54ad4e369e0b6c6f08ead6a49448` | `ZYN80636Eaa7A0A54ad4E369E0b6C6F08eAd6a49448` |
| `ZYNffffffffffffffffffffffffffffffffffffffff` | `ZYNFfFFFfFFfFfFfffFFFfFffFFFfffFFfFfFfFFfFf` |
| `ZYN0000000000000000000000000000000000000000` | `ZYN0000000000000000000000000000000000000000` |

(The first four are the addresses of secp256k1 private keys 1, 2, n−1 and
`4c0883a6…3f362318`.)

## Implementations

- Website: `website/wallet-core.js` (`toChecksumAddress`, `parseAddressInput`), tested by
  `website/test-wallet-core.mjs`.
- CLI: `l1/src/address-checksum.ts` (`address-checksum --address …`; `keygen` and
  `keystore-verify` print it; `--to` accepts it). CLI support ships with the wallet CLI PR (#921).
