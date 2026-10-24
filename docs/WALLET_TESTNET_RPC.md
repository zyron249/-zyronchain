# ZyronChain wallet testnet RPC

Status: **testnet only, no value.** Test ZYN on this network cannot be bought or
sold. Balances and nonces survive a free-host sleep only when durable storage
is configured. They can still reset if that storage is off, or if the network
is deliberately reset.

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
| GET | `/` or `/status` | chain ID, genesis hash, height, tip, tx version, faucet info, `valueBearing: false`, `stateDurable`, `restoredTxCount`, `restoredAccounts` |
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
   `ZYRON_TRUST_PROXY=1`, `ZYRON_TESTNET_SEED=<random 32+ characters>`, and
   optionally `ZYRON_TESTNET_DATABASE_URL` (see below). Do not add a keep-alive
   pinger: free instance hours are shared with other services.

Free web services sleep after about 15 minutes without traffic. The first
request afterwards takes up to a minute. Block production needs a recent
genesis time, so the genesis hash changes on each process start even when
balances were restored. A new genesis hash does not by itself mean balances
were wiped. Compare balances and nonces. If durable storage is off, or the
network is deliberately reset, those balances are gone.

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

## Durable state (optional Postgres)

Set `ZYRON_TESTNET_DATABASE_URL` to a Postgres URL when included transfers and
the per-address faucet day limit should survive a process restart. Leave it
unset to keep the ephemeral behavior.

Expected form:

```text
postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require
```

URL-encode the password. `sslmode=require` is the Neon form (encrypt the
connection). A local database without TLS can omit `sslmode`. Example:
`postgresql://USER:PASSWORD@127.0.0.1:5432/zyron_wallet_testnet`.

Use a **separate Neon database and role** from the Telegram game. Do not point
this variable at the game `DATABASE_URL`. Test ZYN has no value, cannot be
bought or sold, and is not mainnet. The Render blueprint lists the variable
with `sync: false`, so the secret is entered in the dashboard and is never
committed. The RPC uses a short connect timeout. If the database cannot be
reached, it logs a warning and starts non-durable.

`ZYRON_TESTNET_SEED` must stay the same across restarts. The faucet transfer
is signed by the seed-derived faucet key; a new seed cannot replay it.

On startup the script loads `wallet_testnet_tx` and checks whether those
transfers still pass the normal mempool admission path
(`validateMempoolAdmission` and the next-nonce rule) at the current time. When
they do, it submits the original bytes to the validator `POST /tx` and waits
until a block includes them. Balances and next nonces match the previous
process, so a signed transfer must use that restored nonce (current nonce + 1).
The `/testnet/` page reads the nonce from this RPC. The phone wallet stays
offline (`connect-src 'none'`) and does not invent one; copy the next nonce
from that page.

If admission fails because of a timestamp or activity-epoch window, those
bytes cannot be included again. Chain checks are not weakened. The fallback
folds the transfers with the ledger apply rules (a fee is burned, nothing is
minted) and starts from genesis allocations equal to the folded balances. The
sum is never allowed above the configured test genesis amount (faucet
1,000,000 ZYN, validator 1, activity pool 1). A genesis allocation is only
`{address, amountAtoms}`. Consensus rejects any other field, so a nonce cannot
be stored in it. After this fallback the chain reports nonce 0, and the folded
nonce is kept only as a record in `wallet_testnet_baseline.accounts`. Sign the
nonce `GET /nonce` reports. A transfer signed with the pre-fallback nonce will
not be accepted and must be signed again. Rows at or below
`compacted_through_seq` are not replayed, so they are not paid a second time
on top of the folded balances. Ordinary wallet transfers have no timestamp
window, so this fallback is not the path they take.

Schema (created on startup if the role can create tables):

```sql
CREATE TABLE IF NOT EXISTS wallet_testnet_tx (
  chain_id text NOT NULL,
  seq bigserial NOT NULL,
  raw_tx jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_testnet_tx_chain_txid_idx
  ON wallet_testnet_tx (chain_id, (raw_tx->>'txid'));
CREATE TABLE IF NOT EXISTS wallet_testnet_baseline (
  chain_id text PRIMARY KEY,
  compacted_through_seq bigint NOT NULL,
  accounts jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallet_testnet_faucet_limit (
  chain_id text NOT NULL,
  bucket text NOT NULL,
  subject text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  PRIMARY KEY (chain_id, bucket, subject)
);
```

`/status` adds `stateDurable` (`true` or `false`), `restoredTxCount` (included
transfers applied at this start), and `restoredAccounts` (accounts touched by
that restore, or accounts in a fallback baseline).

## Website page

`https://zyronchain.com/testnet/` (`website/testnet/`) reads this RPC from the
browser. It looks up an address (lowercase or a correct display checksum), shows
the balance in ZYN and atoms, the current nonce, the next nonce to sign, the
height and the genesis hash, and can submit a signed transfer the phone wallet
already produced. It never asks for a recovery phrase, a password or a private
key. The phone wallet itself stays offline and only links here.
