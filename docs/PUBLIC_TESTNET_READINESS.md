# Public-testnet readiness

Status: **not launched**. `publicTestnetActivationAllowed` and `publicMiningActivated` stay false. This document records the current Layer-1 architecture, the blocker list for a persistent public testnet, and the fail-closed identity scaffold. It does not freeze a chain ID, genesis allocation, bootstrap list, or RPC hostname.

Checked-in proposal: [`l1/config/public-testnet-identity.json`](../l1/config/public-testnet-identity.json).  
Governance flags: [`l1-launch-authorization.json`](l1-launch-authorization.json).  
Local tester path: [`PUBLIC_TEST.md`](PUBLIC_TEST.md).

## Identity scaffold

`l1/config/public-testnet-identity.json` is an unfilled proposal:

- `status` is `proposal-unfilled`
- `chainId`, `genesisHash`, and `genesisTimestampMs` are null
- `bootstrapPeers` and `publicRpcEndpoints` are empty
- `activationAllowed`, `publicMiningActivated`, and `publicationAllowed` are false inside the file and the parser rejects `true`

`zyron-l1 node --network-class public-testnet` loads that file plus `docs/l1-launch-authorization.json` and refuses to open a data directory unless all of the following hold:

1. status is `identity-frozen` (not the checked-in placeholder);
2. chain ID matches `zyron-public-testnet-<label>`, is at most 64 characters, and does not contain `mainnet`;
3. the supplied genesis chain ID, genesis-block hash, and timestamp match the proposal;
4. at least three bootstrap peers sit in at least three distinct failure domains, on public IPs or public `dns4`/`dns6` names;
5. at least two distinct HTTPS RPC origins are listed, with no loopback, credentials, path, query, or fragment;
6. `publicTestnetActivationAllowed` is true and `mainnetActivationAllowed` is false in the separate launch-authorization file.

The checked-in files fail step 1 and step 6. Forging only the launch flag still fails, because the placeholder has no chain ID or genesis hash. `--network-class mainnet` is rejected so this command cannot invent a mainnet identity. Omitting `--network-class` leaves the existing local and private node path unchanged, including `npm run devnet` and `npm run mine:local`.

Filling the proposal in a later reviewed change is not activation. Activation remains `publicTestnetActivationAllowed` in the launch-authorization file, which this scaffold does not set.

## Architecture (canonical `l1/`)

| Question | What the code does | Gap for a real public testnet |
|---|---|---|
| Node boot | `zyron-l1 node --genesis --data` defaults to `127.0.0.1:9137`. `ChainStore.open` replays the data directory and rejects a stored chain ID or genesis hash that does not match the genesis file. | Boot accepts any well-formed genesis. Nothing persistent names "the" public testnet unless `--network-class public-testnet` is passed, and that path currently fail-closes. |
| Peer discovery | Configured `--p2p-peer` multiaddrs are pinned. Discovery exchanges bounded hints over Noise; callers must dial and complete the chain-identity handshake before admission. Failure-domain labels are operator-supplied. | No checked-in bootstrap list. Labels are not independent failure domains. |
| RPC auth and rate limit | Non-loopback bind requires consensus authentication and at least one `--rpc-trusted-proxy`, and forwarded protocol must be exactly `https`. Fixed-window limits cap tracked client identities and share one overflow quota. | The same HTTP server serves public reads and consensus. There is no deployed public listener and no separate public-RPC process. |
| Consensus vs public RPC | Validator consensus uses authenticated HTTP peers and/or Noise P2P. Public reads are unauthenticated on loopback. | A public testnet still needs an explicit split: loopback or authenticated validator RPC, and a separate HTTPS public RPC tier. |
| Genesis and chain ID | Chain ID must match `^[a-z0-9-]{3,64}$`. Genesis hash is the genesis block hash. Restart identity is the stored chain ID plus that hash. `npm run devnet` mints `zyron-local-<hex>` and does not resume. | No immutable public-testnet chain ID or genesis hash is published. `zyron-devnet-1` is a CLI example. `zyron-render-private-testnet-1` is a private rehearsal. |
| Protocol upgrade and v5 | Height 0 is protocol 1. Supported versions are 1, 2, 3, and 5. Protocol 4 fails closed. A v5 schedule needs >2/3 active-validator approval and at least `MIN_PROTOCOL_UPDATE_DELAY` (100) blocks of delay. | Local `mine:local` can schedule v5 on a disposable chain. That does not activate public mining. |
| Claim flow | Miners sign locally from an encrypted keystore and submit one tip-bound `mining_claim`. A block accepts at most one valid claim. Stale previous-hash claims are rejected. The consensus tracker address `ZYN` + 40 zeroes counts finalized claims and has no spend key. | Public claim submission has nowhere persistent to go. |
| Contention | The mempool keeps the strongest eligible claim for the single mining slot. | No heterogeneous multi-miner contention evidence. The 20-bit target is not calibrated. |
| Rewards and nonce | See the economics section. Claim nonce is the miner account nonce. The tracker nonce is the claim counter. | Economics are implemented and pinned by tests. They are not a frozen public-testnet or mainnet policy beyond the code. |
| Wallet custody | Keystores are scrypt + AES-256-GCM. The miner refuses plaintext private keys. Password files stay on the miner machine. | Production validator custody still requires HSM or an audited remote signer. Remote signer support exists; production evidence does not. |
| HTTPS | Remote miner RPC must be HTTPS. Plain HTTP is accepted only for loopback. Public-testnet RPC origins in a frozen identity must be HTTPS. | No public certificate or hostname is published. |
| Finality | Quorum is `floor(2N/3)+1` distinct validator signatures. Skip certificates are deadline-gated. Mining hash power does not choose the canonical chain. | Multi-validator liveness under split vote is modeled on draft PR #898 and is not changed here. This run did not re-execute that deadlock. |
| Restart identity | One data directory has one writer lease. The signing journal makes attest and skip mutually exclusive across restart. Chain identity is rebound to the genesis file on open. | A public testnet restart only works after one genesis file is frozen and every operator keeps it. |
| Snapshot and sync | Checkpoint and portable-state install require an out-of-band tip hash and snapshot digest. Peers do not choose the trust anchor. | No public archive or checkpoint channel exists. |

## Economics check (consensus code, not docs alone)

Canonical TypeScript constants, now asserted by `l1/test/mining-economics-pin.test.ts`:

| Rule | Code |
|---|---|
| 1 ZYN | `100_000_000` atoms |
| Historical cap | `50_000_000` ZYN, genesis allocations consume it atom-for-atom |
| Initial mining reward | `625_000_000` atoms (6.25 ZYN) |
| Halving | every `4_000_000` finalized claims; next era is 3.125 ZYN |
| Target | fixed 20-bit SHA-256 |
| Mining version | protocol 5 |
| Upgrade delay | 100 blocks |
| Block interval | 30 seconds |
| Claim fee | must be zero |
| Transfer fee | debited from the sender and not credited to the receiver or the miner (`LedgerState.applyTransfer`) |

Canonical docs (`l1/MINING.md`, `docs/MINING.md`, `WHITEPAPER.md`, `STANDALONE_L1_READINESS.md`) match these numbers. No canonical economic constant was changed.

Legacy Python `zyron/blockchain.py` does **not** match: it uses an initial 50 ZYN reward, a 100,000-block halving interval, and pays fees to the miner. That stack is not the canonical L1 and must not be treated as public-testnet issuance.

## Prioritized blockers

P0 items block a shared, persistent public testnet or public mining. This change lands only the fail-closed scaffold for item 1. It closes no activation gate.

| Priority | Blocker | State after this change |
|---|---|---|
| P0 | Persistent public-testnet chain ID, genesis hash, timestamp, and reviewed genesis file | Scaffold exists and fail-closes. Values are still null |
| P0 | Bootstrap peers in at least three independent failure domains, plus archive and monitoring on independent domains | Schema requires three domains before a frozen identity parses. No peers are published |
| P0 | At least two distinct HTTPS public RPC endpoints, separate from validator consensus RPC | Schema requires two origins. None are published |
| P0 | `publicTestnetActivationAllowed` and the 10 requirements in `l1-launch-authorization.json` (issue #260) | Unchanged and false |
| P0 | `miner-network-profile.json` `publicMiningActivated` plus chain, genesis, and RPC | Unchanged: false and null |
| P0 | Multi-validator split-vote liveness | Draft PR #898 models it. Consensus was not modified and the deadlock was not re-run here |
| P1 | Miner multi-RPC failover | Profile still has one `rpcUrl` field. Frozen identity can name two endpoints; the miner does not fail over yet |
| P1 | Mining contention, stale-tip races, inclusion fairness, and a reviewed 20-bit decision | Still required before public mining |
| P1 | Production HSM or audited signer custody and cross-host rotation evidence | Remote signer boundary exists; evidence does not |
| P1 | Always-on hosting across independent providers | Render Free cannot provide it (issue #249) |
| P1 | Protected-branch and required-review settings on the forge | Not provable from a code change |
| P2 | Public explorer, faucet, and checkpoint distribution channel | Absent |
| P2 | External consensus, cryptography, network, and mining audit with retest | Audit pack exists; independent review does not |
| P2 | Target-hardware State-v2 capacity evidence | CI 100k accounts is regression evidence only |
| P3 | One-click miner publication and website download | `publicationAllowed` stays false (issues #390 and #892) |
| P3 | Legacy Python reward schedule | Documented mismatch only. Not ported into `l1/` |
| P3 | Dependency bumps already open as Dependabot PRs | Not part of testnet identity |

## Remaining public-mining activation count

**10** requirements in `publicTestnetActivationRequirements` remain open. Public mining additionally stays off because `publicMiningActivated` is false and the identity proposal is unfilled.

A future review may replace the null identity fields. That still must not set `publicTestnetActivationAllowed`, `mainnetActivationAllowed`, `publicMiningActivated`, or `publicationAllowed`.
