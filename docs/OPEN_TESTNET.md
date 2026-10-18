# ZyronChain open testnet

> **TESTNET — tokens have no value.** Test ZYN cannot be bought or sold and is not redeemable for mainnet ZYN. The network may be reset at any time. ZyronChain has **not** had a professional security audit.

The open testnet runs the canonical TypeScript L1 (`l1/`) with:

| Property | Value |
|---|---|
| Chain ID | `zyron-open-testnet-1` (box-hosted) or `zyron-open-testnet-render-1` (Render free profile). Never a mainnet chain ID. |
| Consensus | Protocol **v6** (locked two-phase BFT) from height 101. Heights 1-100 are built offline at genesis creation and carry the unanimous v6 upgrade, so every live block is a v6 block with a commit certificate. Activating v6 here is a testnet-only decision; it does not activate v6 on any value-bearing network. |
| Genesis profile | `fixed-supply-v1`: 50,000,000 test ZYN in four accounts (5M founder vesting, 20M public distribution, 20M permanent liquidity, 5M ecosystem pool), with the same consensus-enforced locks, rolling 24-hour activity cap and mining ban as the mainnet plan. All keys are freshly generated **test** keys. |
| Validators | 4 (quorum 3). One validator can stop without halting finality. |
| Faucet | Public-distribution test account. 100 test ZYN per address per day, 5 requests per IP per day, 200 per hour overall. |
| Block interval | About 30 seconds. |

## Public gateway

`scripts/open-testnet.mjs run` starts the four validators on loopback and one public gateway. The gateway exposes only:

| Method | Path | Purpose |
|---|---|---|
| GET | `/` or `/explorer` | Block explorer and faucet page |
| GET | `/api` | Endpoint list and chain summary |
| GET | `/health` (`/healthz`, `/readyz`) | 200 while at least a quorum of validators answers; per-validator height and readiness. During start-up `/health` answers 200 with `status: "starting"` and the current `phase` while start-up makes progress (a phase change, a download attempt, a replayed block, a validator copy, a block of a fresh TEST genesis), and 503 with `status: "stalled"` after 5 minutes without progress so the host restarts it. Once the validator processes start, `/health` answers 200 `starting` until a quorum serves, for at most 10 minutes from that point, and 503 `degraded` after that or whenever the quorum is later lost; `/readyz` and all other endpoints answer 503 until the validators serve |
| GET | `/status`, `/network`, `/genesis` | Chain ID, genesis hash, height, protocol version, public role addresses |
| GET | `/account/{address}`, `/balance/{address}`, `/nonce/{address}` | Account state |
| GET | `/blocks?from=&limit=` (limit ≤ 20), `/block/{height}` | Block summaries |
| POST | `/tx` | Signed `transfer` transactions for this chain ID only |
| POST | `/faucet` `{"address":"ZYN…"}` | Test ZYN drip |

Consensus, governance and block-acceptance endpoints are never exposed. Reads and submissions fail over across validators, so a single validator restart does not interrupt the API.

## Use it

```sh
git clone https://github.com/zyron249/-zyronchain.git
cd -- -zyronchain/l1 && npm ci && npm run build
umask 077
node dist/src/cli.js keygen --out "$HOME/zyron-tester/wallet.json" --password-file "$HOME/zyron-tester/wallet.password"
curl -s -X POST -H 'content-type: application/json' -d '{"address":"ZYN<your-40-hex>"}' "$GATEWAY/faucet"
curl -s "$GATEWAY/account/ZYN<your-40-hex>"
```

Send a transfer with `node dist/src/cli.js transfer --rpc "$GATEWAY" --chain-id <chain ID from /status> ...` (see [PUBLIC_TEST.md](PUBLIC_TEST.md)).

## Run your own copy

```sh
cd l1 && npm ci && npm run build
node scripts/open-testnet.mjs init --dir "$HOME/zyron-open-testnet"   # fresh TEST keys, mode 0600
node scripts/open-testnet.mjs run  --dir "$HOME/zyron-open-testnet" --port 10000
npm run testnet:open:smoke   # disposable end-to-end check (also a CI job)
```

The directory holds plaintext **test** validator and faucet keys. Keep it outside the repository and never reuse those keys anywhere else. Expose the gateway port through a reverse proxy or tunnel; never expose validator ports.

### Free hosting profile

[`deploy/open-testnet/render.yaml`](../deploy/open-testnet/render.yaml) runs the same profile on a Render **free** web service with no persistent disk. State survives restarts through sealed snapshots:

- With `ZYRON_TESTNET_STATE_SECRET` set (Render generates it; it is stored nowhere else), the gateway serves `GET /state/snapshot`: genesis, TEST keys and all finalized blocks, gzip + AES-256-GCM. Rate limited to 30 per hour.
- [`deploy/open-testnet/snapshot-keeper.sh`](../deploy/open-testnet/snapshot-keeper.sh) runs on an always-on machine. Every 10 minutes it downloads the snapshot and publishes it as the `state.enc` asset of the `open-testnet-state` prerelease. It also keeps a per-genesis copy. Its polling keeps the free instance from idling.
- On a cold start, `run --init-if-missing --restore-url <asset>` decrypts the snapshot, checks the genesis hash and keys, replays every block through normal validation once, writes a recovery checkpoint that the other validators verify and start from, and resumes the same chain. A fresh genesis is created only if no snapshot exists or the restore fails, and the failure is logged. Transient download failures are retried first. `network.json` is the completion marker: it is written last, through a temporary file that is fsynced and renamed into place. A directory without a valid marker (an interrupted restore or init, for example a restart after a stall, a failed restore, a marker torn by a crash, or one that does not match `genesis.json` and the faucet key) is moved aside to `<dir>.incomplete-<time>-<pid>/<dir name>`, a freshly reserved holder (never deleted, never replacing an existing path), so the next attempt starts clean and the snapshot is restored again; a directory with top-level entries the testnet does not create is refused and left untouched.
- The gateway binds its port (`--port`, else `$PORT`, else 10000) before the restore starts, so hosts that scan for an open port see it immediately. The log reports how long each start-up phase took (`download`, `decrypt`, `replay`, `validators`).
- The blueprint auto-deploys commits to `main` only when they touch `l1/**` or `deploy/open-testnet/**` (`buildFilter`), because every deploy restarts the instance and blocks produced after the last published snapshot are lost. Docs-only merges do not restart the testnet.
- `GET /status` reports `persistence.mode` (`snapshot-restore`, `fresh-genesis` or `local-disk`).

Limits: up to about 10 minutes of the newest blocks can be lost on an unplanned restart, and they are produced again from that height. Validator signing journals are not part of the snapshot. This is acceptable only because the network has no value.

## Join as a validator (volunteers)

The current validator set is run by the project from one host, so it is **not** yet an independent-operator network. Volunteers help close that gap. **Follower nodes can join now:** sync from the public peer endpoint `https://zyron-open-testnet.onrender.com/peer` with the genesis from `GET /genesis` (see the guide). **Validator activation is not possible yet:** the hosted validators are on loopback and only expose a read-only peer surface, so a volunteer cannot exchange v6 consensus messages with them. Full guide: [`VALIDATOR_VOLUNTEERS.md`](VALIDATOR_VOLUNTEERS.md).

1. Run `npm run testnet:open:smoke` on your Linux/macOS host to confirm your environment.
2. Generate a validator key with `node dist/src/cli.js keygen` and share **only** the public key and address (open a GitHub issue titled `Open testnet validator: <name>`).
3. The existing validators add you through the on-chain validator-update governance flow (`validator-proposal`, `validator-approve`, `validator-submit`; activation at least the minimum update delay ahead). Your node syncs from the peer endpoint and would start signing at the activation height. This step waits on a reachable consensus endpoint for the hosted validators.
4. Keep your key and signing journal on durable local storage; never run two copies of one validator key.

Never send a private key, password file or signer token to anyone, including project maintainers.

## What this testnet does not prove

- No independent operators yet, single host, single region.
- AI reviews and community testing are not a professional audit.
- No mainnet, value-bearing token or trading is enabled by this profile.

Report bugs as GitHub issues and vulnerabilities through [SECURITY.md](../SECURITY.md).
