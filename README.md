# ZyronChain

ZyronChain is a simple blockchain project built with Python and Flask.

## Live Explorer

https://zyronchain.onrender.com

## Features

- Proof-of-Work mining
- Genesis Block
- Transactions
- Wallet address generation
- Mining rewards
- Flask REST API
- Web Blockchain Explorer
- GitHub Actions CI
- Render deployment

## Project Structure

```text
zyronchain/
├── app.py
├── main.py
├── requirements.txt
├── templates/
│   └── index.html
└── zyron/
    ├── block.py
    ├── blockchain.py
    ├── transaction.py
    └── wallet.py
## API Routes

```text
GET /                Explorer page
GET /api             Blockchain status
POST /mine/<address> Mine a new block (admin token required)
GET /balance/<address>  Check wallet balance
POST /transaction    Add a signed transaction
```

## Roadmap

- Dark mode explorer
- Create transaction form
- Mine block button
- Wallet generator page
- Digital signatures
- P2P node system
- Testnet
- Mainnet

## Status

ZyronChain is currently in early development.
## Current Version

v0.2.0 Testnet Hardening Release
## Live Demo

https://zyronchain.onrender.com


## Security Defaults

ZyronChain is a testnet project and must not be presented as production/mainnet-ready yet.

- Consensus validates the exact mining subsidy plus transaction fees.
- Transaction amounts, fees, and timestamps must be finite.
- Duplicate transaction IDs are rejected across the validated chain.
- Persisted chain data is consensus-validated before startup accepts it.
- Administrative node operations require `ZYRON_ADMIN_TOKEN` and the `X-Zyron-Admin-Token` request header.
- Server-side wallet generation and mnemonic recovery endpoints are disabled; wallet secrets stay in the browser.
- Testnet faucet mining is disabled by default and requires `ZYRON_ENABLE_TESTNET_FAUCET=1`.
- Private keys must never be submitted to the node API.

### Admin API configuration

Set a strong random token in the node environment:

```text
ZYRON_ADMIN_TOKEN=<strong-random-secret>
ZYRON_RATE_LIMIT_STORAGE_URI=redis://<host>:6379/0
```

Send it only to administrative endpoints over HTTPS:

```text
X-Zyron-Admin-Token: <strong-random-secret>
```

For multi-process or multi-instance deployments, set `ZYRON_RATE_LIMIT_STORAGE_URI` to a shared Redis URL (for example `redis://host:6379/0`). The in-memory default is intended only for a single local/test process.


## Run a persistent testnet node

Use one application worker per node because consensus and mempool state are held in-process and persisted through PostgreSQL.

```bash
export DATABASE_URL=postgresql://...
export ZYRON_ADMIN_TOKEN=<strong-random-secret>
export ZYRON_RATE_LIMIT_STORAGE_URI=redis://127.0.0.1:6379/0
gunicorn --workers 1 --bind 0.0.0.0:5000 app:app
```

Run tests before deploying:

```bash
pytest -q
```

### Node-to-node behavior

Nodes compare valid chains by cumulative proof-of-work. A higher-work chain is accepted only after full consensus validation. Pending and orphaned signed transactions are revalidated against the winning chain before returning to the mempool.

New transactions use protocol v2 (secp256k1 with SHA-256). Legacy v1/SHA-1 signatures remain accepted only when validating historical chain data and are rejected from the live mempool.
