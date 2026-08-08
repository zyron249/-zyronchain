# ZyronChain standalone Layer 1

This directory contains the standalone TypeScript Layer-1 implementation. It is intentionally separate from the historical Python/Flask `zyron-testnet-1` node so the existing testnet remains recoverable while the new consensus core matures.

## What exists now

- deterministic account state with exact integer atom balances and nonces;
- secp256k1 signed transfers and signed Proof-of-Activity settlement batches;
- SHA-256 transaction/block IDs, transaction Merkle roots, and deterministic state roots;
- genesis-pinned chain identity and a hard 50,000,000 ZYN supply ceiling;
- round-robin PoA proposals plus strictly-greater-than-2/3 validator attestations;
- append-only finalized block storage, replay-on-startup validation, and a persistent anti-double-sign journal;
- bounded mempool with nonce conflict protection and state-aware block selection;
- bounded JSON RPC for status, blocks, balances, nonces, transaction submission, proposal attestation, and finalized-block acceptance;
- static-peer identity handshake and incremental finalized-block synchronization;
- CLI key generation, genesis creation, node execution, and signed transfer submission.

One ZYN is `100,000,000` atoms. Transaction fees are currently burned: the sender is debited `amount + fee`, the receiver is credited `amount`, and no new balance is created. Proof-of-Activity settlement cannot mint supply; it may only distribute atoms already allocated to the configured activity pool.

## Build and verify

Requires Node.js 22 or newer.

```sh
npm ci
npm run typecheck
npm test
npm audit --omit=dev
```

## Private devnet quick start

Generate one key file for each validator and another for the activity oracle. Key files contain private keys and are created mode `0600`.

```sh
npm run build
node dist/src/cli.js keygen --out validator-a.json
node dist/src/cli.js keygen --out validator-b.json
node dist/src/cli.js keygen --out oracle.json
```

Create a genesis file using the printed public keys and addresses. The activity pool must be an address included in the allocations if activity rewards are intended. Repeat `--validator-public-key`, `--oracle-public-key`, and `--allocation` as needed.

```sh
node dist/src/cli.js genesis \
  --out genesis.json \
  --chain-id zyron-devnet-1 \
  --validator-public-key <validator-a-public-key> \
  --validator-public-key <validator-b-public-key> \
  --oracle-public-key <oracle-public-key> \
  --activity-pool <pool-address> \
  --allocation <funded-address:atoms> \
  --allocation <pool-address:atoms>
```

Start validator nodes with distinct data directories and ports. Static peers are deliberate: public, unauthenticated peer admission is not used as a shortcut for mainnet discovery.

```sh
node dist/src/cli.js node --genesis genesis.json --data data-a --validator-key validator-a.json --port 9137 --peer http://127.0.0.1:9138
node dist/src/cli.js node --genesis genesis.json --data data-b --validator-key validator-b.json --port 9138 --peer http://127.0.0.1:9137
```

Create another key for a funded wallet and submit a signed transfer:

```sh
node dist/src/cli.js transfer --key wallet.json --rpc http://127.0.0.1:9137 --chain-id zyron-devnet-1 --to <address> --amount-atoms 100000000 --fee-atoms 1000
```

Never commit generated key files or live genesis operator secrets.

## RPC surface

| Method | Path | Purpose |
|---|---|---|
| GET | `/status` | Chain ID, pinned genesis hash, height, tip hash |
| GET | `/blocks?from=1&limit=100` | Bounded finalized-block sync |
| GET | `/balance/<address>` | Exact atom balance |
| GET | `/nonce/<address>` | Confirmed account nonce |
| POST | `/tx` | Strictly parsed signed transaction submission |
| POST | `/proposal/attest` | Validator-only proposal validation and attestation |
| POST | `/block` | Validate and persist a finalized quorum block |

## Consensus safety boundary

Only consensus `round=0` is accepted today. This is deliberate. Enabling fallback rounds without a certified view-change/locking protocol can create two quorum-certified blocks at the same height. Until a tested view-change protocol is implemented, an offline scheduled proposer stops progress rather than weakening safety.

This implementation is therefore suitable for controlled multi-validator devnet/testnet operation, not an unaudited public mainnet. See `../docs/STANDALONE_L1_READINESS.md` for the remaining mainnet gates.
