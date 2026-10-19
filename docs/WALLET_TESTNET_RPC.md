# ZyronChain wallet testnet RPC

Status: **testnet only, no value.** Test ZYN on this network cannot be bought or
sold, and the network resets whenever the free host restarts.

This is a small public RPC that wallets (the MetaMask Snap in `snap/` and the
phone wallet) can use to read balances and nonces and submit test transfers. It
is separate from the gated public testnet (`zyron-public-testnet-1`, see
`STANDALONE_L1_READINESS.md`) and does not change any mainnet rule.

## What it runs

`l1/scripts/public-testnet-rpc.mjs` starts:

- one canonical L1 validator process (`dist/src/cli.js node`) bound to
  `127.0.0.1` only, producing a block every 30 seconds;
- a public HTTP gateway on `$PORT` that forwards only the endpoints below.

Genesis (chain ID `zyron-wallet-testnet-1`) is created at start-up with keys
that are generated at runtime, or derived from `ZYRON_TESTNET_SEED`, a
testnet-only secret set on the host. It allocates only test amounts:

| account | test ZYN |
|---|---|
| faucet | 1,000,000 |
| validator | 1 |
| activity pool | 1 |

No mainnet allocation, allocation lock, founder or treasury key is used or
referenced. The 50,000,000 ZYN maximum-supply rule is unchanged and enforced by
the same chain code.

## Public API

All responses are JSON and carry `access-control-allow-origin: *` (Snaps call
with origin `null`; nothing uses cookies).

| method | path | notes |
|---|---|---|
| GET | `/health` | `200` once the validator answers; used by the host health check |
| GET | `/` or `/status` | chain ID, genesis hash, height, tip, tx version, faucet info, `valueBearing: false` |
| GET | `/genesis` | the testnet genesis document |
| GET | `/account/{address}` | balance (atoms) and nonce |
| GET | `/balance/{address}`, `/nonce/{address}` | single values |
| POST | `/tx` | a signed `transfer` for this chain ID only, forwarded unchanged to the validator mempool |
| POST | `/faucet` | `{"address":"ZYN..."}`; sends 100 test ZYN |

`/account`, `/balance`, `/nonce` and `POST /faucet` accept either the canonical
address (`ZYN` + 40 lower-case hex) or a correct display checksum
(`docs/ADDRESS_CHECKSUM.md`). A mixed-case address with the wrong checksum is
rejected (`Address checksum mismatch`). The gateway normalizes a valid input to
the canonical lower-case form before it calls the node, before it applies the
per-address faucet limit, and in every response `address` / `receiver` field.
The same account therefore shares one faucet drip whether the client sends the
lower-case form or the checksummed form. L1 consensus addresses are unchanged:
the node still stores and matches only the lower-case form.

`POST /tx` does **not** normalize `sender` or `receiver`. Those fields are part
of the signed canonical JSON, so rewriting their case would make a valid
signature fail. A checksummed or otherwise non-canonical address is rejected
with the lower-case form to submit instead. A correct signature over the
canonical lower-case addresses is forwarded unchanged.

Everything else returns `404`; consensus endpoints (`/block`, `/proposal/*`,
`/round/*`, `/v6/*`) and `/blocks`, `/peers`, `/metrics` are not exposed.

Limits per client (IPv4 address or IPv6 /64). With `ZYRON_TRUST_PROXY=1`
(Render, which serves web services through Cloudflare) the client is taken from
the `CF-Connecting-IP` header that the edge sets; the client-supplied leftmost
`X-Forwarded-For` entry is never used, and a request without a valid header
shares the proxy's bucket. Never set `ZYRON_TRUST_PROXY=1` where clients can
reach the service without passing through Cloudflare. Limits:
120 reads/min, 10 transaction submits/min, 5 faucet requests/day, one faucet
drip per address per day, 200 faucet drips per hour in total. Request bodies are
capped at 8 KB.

## Deploy (Render free web service)

The repo cannot create a Render service by itself. In the Render dashboard:

1. **New > Blueprint**, pick this repository, set the Blueprint path to
   `deploy/render/wallet-testnet-rpc.yaml`, and apply. It creates one free web
   service, `zyron-wallet-testnet-rpc`, and leaves every other service alone.
2. Or **New > Web Service** with: root directory `l1`, runtime Node, build
   `npm ci && npm run build`, start `node scripts/public-testnet-rpc.mjs`,
   health check `/health`, plan Free, env `NODE_VERSION=22`,
   `ZYRON_TRUST_PROXY=1`, `ZYRON_TESTNET_SEED=<random 32+ characters>`.

Free web services sleep after about 15 minutes without traffic. The first
request afterwards takes up to a minute and starts a **fresh genesis**: balances
reset and the genesis hash changes. Wallets should compare the genesis hash and
treat a change as a reset.

## Local run and smoke test

```bash
cd l1 && npm ci && npm run build
PORT=8787 node scripts/public-testnet-rpc.mjs           # run locally
node scripts/public-testnet-rpc.mjs --smoke             # CI smoke test
```

The smoke test checks `/health`, CORS, the endpoint allowlist, the faucet and
its per-address limit (including a checksummed request followed by the
lower-case form of the same address), wrong-checksum rejection, canonical
responses for lower-case and checksummed reads, a wrong-chain rejection, a
refusal to rewrite checksummed `sender` / `receiver` on `POST /tx`, and a
finalized transfer between two fresh test accounts.
