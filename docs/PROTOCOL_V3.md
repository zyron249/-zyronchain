# ZyronChain Protocol v3

Status: testnet hardening protocol. New mempool transactions use v3. Historical transaction
versions v1 and v2 and legacy block headers remain validation-compatible.

## Network identity

- Name: ZyronChain
- Chain ID: `zyron-testnet-1`
- Currency unit: ZYN
- Atomic unit: 1 ZYN = 100,000,000 atoms
- Maximum supply: 50,000,000 ZYN
- Initial block subsidy: 50 ZYN
- Halving interval: 100,000 blocks

## Transaction v3

Consensus fields are exactly:

`version, chain_id, nonce, sender, receiver, amount_atoms, fee_atoms, timestamp_ms, public_key, signature, txid`

Unknown or missing fields are rejected. Amounts and fees are integer atoms and timestamps are
integer Unix milliseconds. This removes floating-point and locale/format ambiguity from new
consensus data.

The unsigned signing payload contains every field above except `signature` and `txid`.
It is UTF-8 JSON serialized with lexicographically sorted keys and separators `,` and `:`
without whitespace.

Signatures use secp256k1 ECDSA with SHA-256, deterministic RFC6979 nonces, compact 64-byte
`r || s` encoding and mandatory low-S normalization. The txid is SHA-256 of the same
canonical v3 object after adding `signature`, excluding `txid`.

Python consensus signing/verification uses libsecp256k1 through coincurve. The browser wallet
uses the locally vendored Noble secp256k1 bundle. A fixed cross-language test vector locks both
implementations to the same signature bytes.

Legacy v1 SHA-1 and v2 SHA-256 signatures are accepted only when validating historical chain
data. New mempool admission requires the current protocol version.

## Block v2 header

Newly mined blocks use block header version 2. Header consensus fields are:

`version, index, timestamp_ms, merkle_root, previous_hash, difficulty, nonce`

`timestamp_ms` is integer Unix milliseconds. `merkle_root` commits to the canonical JSON
of every transaction. Leaves are SHA-256 hashes; pairs are SHA-256(left || right), duplicating
the final hash for odd-sized levels. The empty root is SHA-256 of empty bytes.

Legacy block headers remain hash-compatible so existing testnet history and the fixed genesis
block are not rewritten.

## Monetary consensus

Coinbase/SYSTEM payout must equal the scheduled block subsidy plus fees from that block.
Fees are redistributed, not counted as new supply. Supply, balances, spending and v3 fees are
calculated in integer atoms.

## Fork choice

Only fully validated candidate chains with strictly greater cumulative proof-of-work replace
the local chain. Reorged non-SYSTEM transactions are revalidated before returning to mempool.

## Resource limits

- 1,000 user transactions per block plus one SYSTEM transaction
- 1,000,000 serialized bytes per block
- 5,000 mempool transactions
- 1 hour mempool TTL
- 120 second future-transaction tolerance
- 120 second future-block tolerance
- bounded peer JSON reads before parsing

Consensus changes must be versioned and accompanied by deterministic test vectors.
