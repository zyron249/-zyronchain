# ZyronChain open testnet

> **TESTNET — tokens have no value.** Test ZYN cannot be bought or sold and is not redeemable for mainnet ZYN. The network may be reset at any time. ZyronChain has **not** had a professional security audit.

The open testnet runs the canonical TypeScript L1 (`l1/`) with:

| Property | Value |
|---|---|
| Chain ID | `zyron-open-testnet-1` (box-hosted) or `zyron-open-testnet-render-1` (Render free profile). Never a mainnet chain ID. |
| Consensus | Protocol **v6** (locked two-phase BFT) from height 101. Heights 1-100 are built offline at genesis creation and carry the unanimous v6 upgrade, so every live block is a v6 block with a commit certificate. Activating v6 here is a testnet-only decision; it does not activate v6 on any value-bearing network. |
| Genesis profile | `fixed-supply-v1`: 50,000,000 test ZYN in four accounts (5M founder vesting, 20M public distribution, 20M permanent liquidity, 5M ecosystem pool), with the same consensus-enforced locks and mining ban as the mainnet plan. The public-distribution faucet vests with no cliff and a 365-day linear release, so the full 20M is not spendable on day one; drips come from the vested slice. Activity settlements use `threshold-v1` with three freshly generated test oracle keys and threshold 2 (2-of-3). The cap is the 1,000 test ZYN default. These oracle keys are disposable test keys, not a production oracle set. The network has no value and does not declare a value-bearing `networkClass`. |
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
- On a cold start, `run --init-if-missing --restore-url <asset>` decrypts the snapshot, checks the genesis hash and keys, replays every block through normal validation once, writes a recovery checkpoint that the other validators verify and start from, and resumes the same chain. Below a recovery checkpoint a validator only line-scans its block log on open, so each validator's copied files are compared (SHA-256) with the replayed ones before they are opened, and every validator's files again right before the completion marker; a mismatch fails the restore. Every copy step reports start-up progress, so a long restore of a large log is not mistaken for a stall. A fresh genesis is created only if no snapshot exists or the restore fails, and the failure is logged. Transient download failures (5xx, network errors, a body cut off mid-transfer) are retried for 172 s first, so a short outage of the asset host does not reset the network. A 404 is retried for 160 s before it counts as "no snapshot published", because a keeper replacing the asset can leave it briefly missing. `network.json` is the completion marker: it is written last, through a temporary file that is fsynced and renamed into place. A directory without a valid marker (an interrupted restore or init, for example a restart after a stall, a failed restore, a marker torn by a crash, or one that does not match `genesis.json` and the faucet key) is moved aside to `<dir>.incomplete-<time>-<pid>/<dir name>`, a freshly reserved holder (never replacing an existing path), so the next attempt starts clean and the snapshot is restored again; a directory with top-level entries the testnet does not create is refused and left untouched. Only the newest 3 holders (including the one just created) are kept: an older holder is removed only if it holds nothing but what the testnet itself creates (keys, genesis, and in each validator data directory only the files a validator store writes; no operator file, symlink, special file, foreign name or unexpected layout); any other holder is never removed and does not count toward the bound. Old holders are pruned before the new holder is reserved, so a disk filled by earlier attempts can make room. Holder names keep creation order even if the clock moves back: the time in a new name is never below the newest existing holder's, and at an equal time its counter goes past that holder's. A holder is removed only if it is still the one that was inspected: it is first renamed to a private name, checked again there (same layout, and the same inodes, sizes and modification times), and renamed back and kept if anything changed. Leftover temporary or quarantined copies count as testnet-created only on the files whose writers create them. A holder with a mount point at or inside it (including a bind mount), or a directory on another device, is never removed; on Linux, a mount table that cannot be read keeps the holder. File and holder names count only if they are exactly what the writers produce. A holder left under its private name by a crash during removal is finished off on the next start if it is still prunable, and otherwise renamed back under its own name and kept. A holder that cannot be inspected, or a removal failure, is logged without failing the restart.
- The gateway binds its port (`--port`, else `$PORT`, else 10000) before the restore starts, so hosts that scan for an open port see it immediately. The log reports how long each start-up phase took (`download`, `decrypt`, `replay`, `validators`).
- The blueprint auto-deploys commits to `main` only when they touch `l1/**` or `deploy/open-testnet/**` (`buildFilter`), because every deploy restarts the instance and blocks produced after the last published snapshot are lost. Docs-only merges do not restart the testnet.
- `GET /status` reports `persistence.mode` (`snapshot-restore`, `fresh-genesis` or `local-disk`).

Limits: up to about 10 minutes of the newest blocks can be lost on an unplanned restart, and they are produced again from that height. Validator signing journals are not part of the snapshot. This is acceptable only because the network has no value.

### Snapshot keepers

Two keepers can publish the snapshot. Neither needs the state secret: the gateway seals the snapshot itself, so a keeper only needs write access to the release assets.

- **Scheduled GitHub Actions job** ([`.github/workflows/open-testnet-snapshot-keeper.yml`](../.github/workflows/open-testnet-snapshot-keeper.yml), logic in [`.github/scripts/open-testnet-snapshot-keeper.mjs`](../.github/scripts/open-testnet-snapshot-keeper.mjs)). It does not depend on any machine being on. It polls `/health` every 5 minutes and publishes every 10 minutes, using the workflow `GITHUB_TOKEN` with `contents: write`. GitHub delays or drops scheduled runs under load, often by hours, so each run keeps working for about 5 h 40 min instead of exiting after one cycle. The concurrency group `open-testnet-snapshot-keeper` keeps exactly one run active. The next scheduled run waits as pending and takes over when the active run ends. GitHub cancels older pending runs, so cancelled scheduled runs in the list are expected. A manual `workflow_dispatch` run also waits behind an active run.
- **Legacy machine keeper** ([`deploy/open-testnet/snapshot-keeper.sh`](../deploy/open-testnet/snapshot-keeper.sh)), run on an always-on machine with an authenticated `gh`. It only covers the time that machine is running. It is a fallback for when the scheduled workflow is disabled; do not run it next to the scheduled job (see below).

Rules the Actions keeper enforces:

1. It never publishes a snapshot whose genesis hash differs from the pinned `EXPECTED_GENESIS`, or a response that is not a sealed open-testnet snapshot. A genesis mismatch fails the run so it is visible. A run also fails when it never published and never found the published asset up to date, for example because every cycle refused to replace a `state.enc` labeled for another genesis.
2. The published height never goes backwards. The keeper labels each asset it publishes with `height=<n> genesis=<hash>` and replaces a labeled asset only with a higher height. An unlabeled asset (written by the legacy keeper) is replaced only by a snapshot requested more than 2 minutes after that asset was updated. The gateway caches a snapshot for at most 60 seconds, so such a snapshot is at least as high. It checks again right before the swap.
3. The published asset is never deleted before its replacement is in place. The new file is uploaded as `next-<ms>-<hex>.state.enc`, the current asset is renamed aside to `prev-<ms>-<hex>.state.enc`, and the new file is renamed to `state.enc`. The moved-aside copy is kept as a backup. The publish step itself never deletes anything: an upload it does not install (the name was taken, the re-check right before the swap found a newer asset, the run deadline passed, or a rename failed) stays as a keeper copy, which the repair step installs when `state.enc` is missing or unusable, or the cleanup step ages out. A rename request that fails is checked against a fresh listing, because GitHub may have applied it and lost the response. GitHub refuses a rename to a name that another asset holds (HTTP 422), so when that listing fails too the keeper simply attempts the next step (installing the upload, or renaming the old asset back): it either fills a missing `state.enc` or is refused. If the final rename fails and `state.enc` is free, the moved-aside copy is renamed back; an asset that the listing shows under any other name is not this keeper's copy and is left alone. **Missing-name window:** from the first request that can take `state.enc` away (the aside rename) until the name is held again, every GitHub call and retry wait fits in 120 s (`MISSING_NAME_BUDGET_MS`; 15 s per call, with shares reserved so that the final rename and the rename back always get time). A cold start retries a 404 for 160 s (`SNAPSHOT_NOT_FOUND_RETRY_DELAYS_MS` in `l1/scripts/open-testnet.mjs`, checked by the keeper tests) before it creates a fresh TEST genesis, so a swap never outlasts that grace. When GitHub fails for the whole window, both copies are kept and the next cycle repairs the name; that case is not covered by the grace. The repair step follows the same window: when `state.enc` is missing, or is an asset GitHub does not report as fully uploaded (state `uploaded`) or that is too small to be a sealed snapshot (fully uploaded but too small, or still `starter` 15 minutes after it was created), it moves the unusable asset aside and renames the best complete copy into place, checks a failed rename against a listing, and tries the next copy, until the name is held or the window is spent. A copy labeled for another genesis, or an incomplete one, is never renamed into place or kept as a backup. When `state.enc` itself is unusable, a publish replaces it regardless of its label height (unless it is labeled for another genesis). A fresh `starter` asset can be the legacy keeper's newer snapshot still uploading, so the normal height and 2-minute rules apply to it. No upload, swap, repair rename or cleanup delete is started after the run deadline (minute 340), and a repair that ends after it is not followed by a publication, so a started swap or repair ends well before the 355-minute job timeout. GitHub metadata calls outside the window time out after 60 s (a listing shares one timeout across its pages). A failure of the per-genesis copy does not undo the `state.enc` result. The keeper deletes only its own `next-`/`prev-` copies, and only when they are older than 30 minutes. A complete copy is deleted only while the name it belongs to exists (checked again in a fresh listing right before deleting); an incomplete copy is unusable and is deleted even while the name is missing, so failed uploads do not accumulate. The best restorable copy of each name (highest labeled height of the expected genesis) is always kept as a backup.
4. `/health` is polled on its own 5-minute schedule, independent of publishing, so a slow download or slow GitHub calls never let the instance idle. Polling continues past the run deadline until a publish cycle that started before it has finished; then the pending wait is cancelled, so the job exits at once. Publish cycles start every 10 minutes measured from the previous cycle start (a cycle that took longer is followed immediately), so slow GitHub calls do not stretch the gap between published snapshots. The snapshot download is refused above 256 MiB: a larger `Content-Length` is rejected before reading, and a body without one is read with a hard byte cap. A non-200 response body is not read.
5. When the `open-testnet-state` release does not exist (a fresh fork, or after it was removed), the keeper creates it as a prerelease on the confirmed tag-not-found response and publishes on the same run. Any other listing failure creates nothing.
6. GitHub disables scheduled workflows in a public repository after 60 days without repository activity. When that happens the keeper stops and the testnet idles again. Check that the workflow is enabled (`gh workflow list --all`) and re-enable it with `gh workflow enable open-testnet-snapshot-keeper.yml` or from the Actions tab. Keep a second keeper running until the schedule has a track record.

**Run one keeper at a time.** Once the scheduled job is publishing, stop the legacy machine keeper; run the legacy keeper only while the scheduled workflow is disabled. If both do run, nothing is lost: they read the same live gateway and publish the same chain, the Actions keeper's rules above still hold, and its repair restores `state.enc` from its own copies. But the legacy keeper does not check heights (it can replace an Actions publish with a snapshot a few blocks older, which the next publish repairs) and it replaces an asset by deleting it and then uploading (`gh release upload --clobber`), so during each of its uploads `state.enc` is missing for a few seconds.

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
