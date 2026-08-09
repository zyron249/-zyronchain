# Legacy Python/Flask testnet

> **Status: archived compatibility testnet.** This implementation is not the canonical ZyronChain consensus client and must not be presented as a mainnet candidate. The canonical implementation is the standalone TypeScript L1 in [`l1/`](../l1/README.md). Its network has not been publicly launched.

The material below preserves the historical testnet documentation for replay, migration and compatibility work.

---

# ZyronChain

ZyronChain is a Python/Flask proof-of-work blockchain testnet with independently validated
blocks, signed secp256k1 transactions, cumulative-work fork choice, PostgreSQL persistence,
a browser wallet and a web explorer.

Live explorer: https://zyronchain.onrender.com

## Current release candidate

**v0.3.0 – Protocol v3 hardening**

- 1 ZYN = 100,000,000 integer atoms for new consensus data
- canonical transaction-v3 serialization and deterministic low-S secp256k1/SHA-256 signatures
- transaction IDs commit to the signed canonical transaction
- block-v2 integer timestamps and Merkle transaction commitments
- historical v1/v2 transactions and legacy block hashes remain validation-compatible
- exact block subsidy + fee validation and integer supply accounting
- cumulative proof-of-work fork choice with reorg mempool recovery
- strict transaction/block schemas and resource limits
- browser-only key custody with a locally vendored Noble secp256k1 implementation
- Python signing/verification backed by libsecp256k1 through coincurve
- PostgreSQL suffix/reorg persistence and persisted peer reputation
- admin-token protected node mutation endpoints and shared-Redis rate-limit support
- Python 3.11/3.12 CI plus dependency vulnerability audit

The normative v3 details are in [docs/PROTOCOL_V3.md](docs/PROTOCOL_V3.md).
The engineering launch gate is [docs/MAINNET_READINESS.md](docs/MAINNET_READINESS.md).

## Network parameters

| Parameter | Testnet value |
|---|---:|
| Chain ID | `zyron-testnet-1` |
| Maximum supply | 50,000,000 ZYN |
| Initial block subsidy | 50 ZYN |
| Halving interval | 100,000 blocks |
| Target block time | 30 seconds |
| Difficulty range | 2–8 leading hex zeroes |
| Max user transactions/block | 1,000 |
| Max serialized block | 1,000,000 bytes |
| Mempool limit | 5,000 transactions |
| Mempool TTL | 3,600 seconds |

## Run a persistent testnet node

One application worker is required because consensus and mempool mutation state are serialized
inside the node process.

```bash
export DATABASE_URL=postgresql://...
export ZYRON_ADMIN_TOKEN=<strong-random-secret>
export ZYRON_RATE_LIMIT_STORAGE_URI=redis://127.0.0.1:6379/0

gunicorn --workers 1 --bind 0.0.0.0:5000 app:app
```

Do not expose the admin token to browser clients. Server-side wallet creation/recovery is disabled;
mnemonic phrases and private keys must never be sent to a node.

The testnet faucet is disabled by default. Enable it only on an isolated testnet node with
`ZYRON_ENABLE_TESTNET_FAUCET=1`.

## Verification

```bash
pip install -r requirements.txt
PYTHONPATH=. pytest -q
python -m compileall -q app.py main.py signed_demo.py zyron tests
```

CI runs the suite on Python 3.11 and 3.12 and runs `pip-audit` against runtime dependencies.

## Core API

```text
GET  /                       Explorer
GET  /health                 Node health
GET  /peer/status            Network/protocol identity
GET  /chain                  Validated chain
GET  /block/<index>          Block lookup
GET  /tx/<txid>              Transaction lookup
GET  /address/<address>      Address state/history
GET  /nonce/<address>        Current/next nonce
GET  /mempool                Pending transactions
POST /transaction            Submit a signed protocol-v3 transaction
POST /mine/<address>         Mine a block (admin token required)
POST /nodes/sync             Sync peers (admin token required)
POST /mempool/sync           Sync mempool (admin token required)
POST /sync/all               Full sync operation (admin token required)
```

Administrative requests use the `X-Zyron-Admin-Token` header over HTTPS.

## Mainnet status

This repository is a hardened testnet, not a certified public mainnet. Protocol correctness is
not established by a feature list or by unit tests alone. The remaining P0 gates include a fixed
upgrade activation/checkpoint or fresh mainnet genesis, production headers-first synchronization,
indexed/state-committed ledger state, stronger peer Sybil/eclipse resistance, time-warp-resistant
retarget activation, long-running adversarial multi-node testing, independent security review and
signed/reproducible operational releases. See the readiness document for the exact launch gate.
