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
| GET | `/health` (`/healthz`, `/readyz`) | 200 while at least a quorum of validators answers; per-validator height and readiness. During start-up `/health` answers 200 with `status: "starting"` and the current `phase` while start-up makes progress (a phase change, a download attempt, a replayed block, each step of a validator copy: a copied chunk and file, a step of loading the copy's recovery checkpoint (including every 1024 State-v2 entries rebuilt from it), a stored block record read while the copy is opened, a batch of the copy's rebuilt State-v2 store, a hashed chunk of the byte-for-byte checks; a block of a fresh TEST genesis), and 503 with `status: "stalled"` after 5 minutes without progress so the host restarts it. Once the validator processes start, `/health` answers 200 `starting` until a quorum serves, for at most 10 minutes from that point, and 503 `degraded` after that or whenever the quorum is later lost; `/readyz` and all other endpoints answer 503 until the validators serve |
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

- With `ZYRON_TESTNET_STATE_SECRET` set (Render generates it; it is stored nowhere else), the gateway serves `GET /state/snapshot`: genesis, TEST keys and all finalized blocks, gzip + AES-256-GCM. Rate limited to 30 per hour. Before sealing, the gateway validates the history it reads from the validators the way a cold-start replay does: every block must pass full finalized-block validation (signatures, finality certificate, transactions, state root) on top of the blocks before it, and the history must end at the live tip. For each height the validators are tried in turn and the first valid block is used, so history corrupted on a validator's disk is not published, and honest validators that hold different valid finality certificates for the same block do not stop snapshots. If no validator serves a valid block at some height, no snapshot is served and the last published one stays in place. The gateway keeps the verified history in memory and only validates new blocks on later builds; after a restore it starts from the history the restore has just replayed.
- A snapshot keeper downloads the snapshot every 10 minutes and publishes it as the `state.enc` asset of the `open-testnet-state` prerelease, plus a per-genesis copy. Its polling also keeps the free instance from idling. See [Snapshot keepers](#snapshot-keepers).
- On a cold start, `run --init-if-missing --restore-url <asset>` decrypts the snapshot, checks the genesis hash and keys, replays every block through normal validation once, writes a recovery checkpoint that the other validators verify and start from, and resumes the same chain. Below a recovery checkpoint a validator only line-scans its block log on open, so each validator's copied files are compared (SHA-256) with the replayed ones before they are opened, and every validator's files again right before the completion marker; a mismatch fails the restore. Every copy step reports start-up progress, so a long restore of a large log is not mistaken for a stall. A fresh genesis is created only if no snapshot exists or the restore fails, and the failure is logged. Transient download failures are retried first. `network.json` is the completion marker: it is written last, through a temporary file that is fsynced and renamed into place. A directory without a valid marker (an interrupted restore or init, for example a restart after a stall, a failed restore, a marker torn by a crash, or one that does not match `genesis.json` and the faucet key) is moved aside to `<dir>.incomplete-<time>-<pid>/<dir name>`, a freshly reserved holder (never deleted, never replacing an existing path), so the next attempt starts clean and the snapshot is restored again; a directory with top-level entries the testnet does not create is refused and left untouched.
- The gateway binds its port (`--port`, else `$PORT`, else 10000) before the restore starts, so hosts that scan for an open port see it immediately. The log reports how long each start-up phase took (`download`, `decrypt`, `replay`, `validators`).
- The blueprint auto-deploys commits to `main` only when they touch `l1/**` or `deploy/open-testnet/**` (`buildFilter`), because every deploy restarts the instance and blocks produced after the last published snapshot are lost. Docs-only merges do not restart the testnet.
- `GET /status` reports `persistence.mode` (`snapshot-restore`, `fresh-genesis` or `local-disk`).

Limits: up to about 10 minutes of the newest blocks can be lost on an unplanned restart, and they are produced again from that height. Validator signing journals are not part of the snapshot. This is acceptable only because the network has no value.

### Snapshot keepers

Two keepers can publish the snapshot. Neither needs the state secret: the gateway seals the snapshot itself, so a keeper only needs write access to the release assets.

- **Scheduled GitHub Actions job** ([`.github/workflows/open-testnet-snapshot-keeper.yml`](../.github/workflows/open-testnet-snapshot-keeper.yml), logic in [`.github/scripts/open-testnet-snapshot-keeper.mjs`](../.github/scripts/open-testnet-snapshot-keeper.mjs)). It does not depend on any machine being on. It polls `/health` every 5 minutes and publishes every 10 minutes, using the workflow `GITHUB_TOKEN` with `contents: write`. GitHub delays or drops scheduled runs under load, often by hours, so each run keeps working for about 5 h 40 min instead of exiting after one cycle. The concurrency group `open-testnet-snapshot-keeper` keeps exactly one run active. The next scheduled run waits as pending and takes over when the active run ends. GitHub cancels older pending runs, so cancelled scheduled runs in the list are expected. A manual `workflow_dispatch` run also waits behind an active run.
- **Legacy machine keeper** ([`deploy/open-testnet/snapshot-keeper.sh`](../deploy/open-testnet/snapshot-keeper.sh)), run on an always-on machine with an authenticated `gh`. It only covers the time that machine is running.

Rules the Actions keeper enforces:

1. It never publishes a snapshot whose genesis hash differs from the pinned `EXPECTED_GENESIS`, or a response that is not a sealed open-testnet snapshot. A genesis mismatch fails the run so it is visible.
2. The published height never goes backwards. The keeper labels each asset it publishes with `height=<n> genesis=<hash>` and replaces a labeled asset only with a higher height. An unlabeled asset (written by the legacy keeper) is replaced only by a snapshot requested more than 2 minutes after that asset was updated. The gateway caches a snapshot for at most 60 seconds, so such a snapshot is at least as high. It checks again right before the swap.
3. The published asset is never deleted before its replacement is in place. The new file is uploaded as `next-<ms>-<hex>.state.enc`, the current asset is renamed aside to `prev-<ms>-<hex>.state.enc`, the new file is renamed to `state.enc`, and only then is the old copy deleted. `state.enc` is therefore missing only between two rename calls, not for the length of an upload. If the final rename fails, it is retried and the old asset is renamed back. If even that fails, both copies are kept, and the next cycle renames the highest labeled copy of the expected genesis (or the moved-aside asset) back to `state.enc`. The keeper deletes only its own `next-`/`prev-` copies, only when they are older than 30 minutes, and only while the name they belong to exists (checked again in a fresh listing right before deleting). The best copy of each name (highest labeled height of the expected genesis) is always kept as a backup, because the legacy keeper can delete the name at any moment and fail to upload its replacement.
4. `/health` is polled on its own 5-minute schedule, independent of publishing, so a slow download or slow GitHub calls never let the instance idle. The snapshot download is refused above 256 MiB: a larger `Content-Length` is rejected before reading, and a body without one is read with a hard byte cap. A non-200 response body is not read.
5. GitHub disables scheduled workflows in a public repository after 60 days without repository activity. When that happens the keeper stops and the testnet idles again. Check that the workflow is enabled (`gh workflow list --all`) and re-enable it with `gh workflow enable open-testnet-snapshot-keeper.yml` or from the Actions tab. Keep a second keeper running until the schedule has a track record.

Running both keepers at once is safe. They read the same live gateway and publish the same chain. If two uploads of the same name collide, GitHub accepts only one and the other keeper retries on its next cycle. The legacy keeper does not check heights. If its download started just before an Actions publish, it can replace that asset with a snapshot a few blocks older. The next publish repairs it, and a restore from it simply re-produces those blocks. The legacy keeper replaces an asset by deleting it and then uploading (`gh release upload --clobber`), so during each of its uploads `state.enc` is missing for a few seconds. The Actions keeper is meant to replace it; stop the legacy keeper once the scheduled job has been publishing reliably.

Both keepers fetch `/state/snapshot` about 6 times an hour (limit: 30 per hour for all clients).

Free-plan budget: Actions minutes are free for public repositories, and the job occupies one hosted runner slot. A free web service that is kept awake all month uses about 720-744 of the 750 free instance hours a Render workspace gets per month. Other free web services in the same workspace share that allowance, and when it runs out Render suspends the workspace's free web services until the next month.

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
