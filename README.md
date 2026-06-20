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
GET /mine/<address>  Mine a new block
GET /balance/<address>  Check wallet balance
POST /transaction    Add a new transaction
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
