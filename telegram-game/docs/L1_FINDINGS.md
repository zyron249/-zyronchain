# Phase 0 — ZyronChain findings for ZYRON NODE

Investigated before any game code was added. No consensus, validator, mining, or legacy chain files were modified.

## What the canonical chain is

The canonical client is the TypeScript L1 in `l1/`. It is an account-based, permissioned-validator chain with authenticated State-v2 commitments and >2/3 finality. The Python/Flask tree (`app.py`, `zyron/`) is a legacy compatibility testnet (`zyron-testnet-1`), not the chain this game observes.

Governance authorization exists (`publicTestnetAuthorized=true`, `mainnetAuthorized=true` in `docs/l1-launch-authorization.json`). Activation does not: `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false`. This game must not be described as mainnet, a faucet, or a payout system.

## Networks

| Name | What it actually is |
|---|---|
| `zyron-local-<hex>` | Fresh chain id printed by `cd l1 && npm run devnet`. Local only. New identity every run. |
| `zyron-devnet-1` | Example string in `l1/README.md`. Not a live network. |
| `zyron-render-private-testnet-1` | Ephemeral private Render rehearsal. Not public. |
| `zyron-testnet-1` | Legacy Python chain id. Not canonical. |
| Public testnet / mainnet | Not activated. No hosted public RPC, explorer, faucet, or bootstrap list is published by this repository. |

The historical host `https://zyronchain.onrender.com` is quarantined. Do not point `ZYRON_RPC_URL` at it.

## Address and value format

- Address: `ZYN` + 40 lowercase hex characters. Regex used by the L1: `^ZYN[0-9a-f]{40}$`.
- Derived as `ZYN` + the first 40 hex chars of SHA-256 of the uncompressed public key without the `04` prefix (`l1/src/crypto.ts`).
- 1 ZYN = `100_000_000` atoms (`l1/src/types.ts`).
- Supply ceiling on the canonical chain is 50,000,000 ZYN. Fees burn. This game does not mint, burn, or transfer atoms.
- `ZYN` + 40 zeroes is the mining-tracker address. The game rejects it as a watch address.
- ZyronChain is not EVM. MetaMask cannot connect.

## RPC the game may read

Wallet/public HTTP and validator consensus networking are separate. Every current response advertises `x-zyron-rpc-version: 1`. The game sends that header on reads.

Allowed GET paths, from `l1/README.md` and `l1/src/node-base.ts`:

| Path | Use in the activity panel |
|---|---|
| `/status` | `chainId`, `genesisHash`, `height`, `tipHash` |
| `/healthz` | Reachability |
| `/protocol` | Current and next protocol version |
| `/rpc-info` | API version (not required for the panel) |
| `/balance/<address>` | `{ address, balanceAtoms }` |
| `/nonce/<address>` | `{ address, nonce }` |
| `/blocks?from=&limit=` | Recent finalized blocks, summarized |

`/blocks` requires `from >= 1`. The panel asks for at most 5 blocks ending at the reported height. Responses are cached and the client is globally rate-limited. Only height, time, hash prefix, transaction count, kind counts, and whether the linked address appears as sender or receiver are returned to the Mini App. Signatures and full transactions are not stored as game records.

## RPC the game must not call

`POST /tx`, `POST /block`, `POST /proposal/attest`, and `POST /round/skip` are consensus or submission surfaces. The game client has no method that performs them. Remote RPC, when an operator explicitly enables it, must be HTTPS. Loopback HTTP is the supported local devnet case. Link-local metadata hosts are rejected.

There is no public explorer API to call. Block summaries come from the operator's own node.

## How the game uses this

`ZYRON_RPC_URL` defaults to empty. The activity panel then says the observer is offline instead of inventing chain data. A local tester can export the loopback URL printed by `npm run devnet`. That URL changes every run; do not hard-code port 9137. The game never converts an on-chain balance into Zyron Points.
