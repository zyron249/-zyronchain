# Public-testnet readiness

Status: **not launched**. `publicTestnetActivationAllowed` and `publicMiningActivated` stay false. This document records the current Layer-1 architecture, the blocker list for a persistent public testnet, and the fail-closed identity scaffold. It does not freeze a chain ID, genesis allocation, bootstrap list, or RPC hostname.

Checked-in identity proposal: [`l1/config/public-testnet-identity.json`](../l1/config/public-testnet-identity.json).  
Checked-in bootstrap proposal: [`l1/config/public-testnet-bootstrap.json`](../l1/config/public-testnet-bootstrap.json).  
Checked-in public RPC proposal: [`l1/config/public-testnet-rpc.json`](../l1/config/public-testnet-rpc.json).  
Governance flags: [`l1-launch-authorization.json`](l1-launch-authorization.json).  
Local tester path: [`PUBLIC_TEST.md`](PUBLIC_TEST.md).

## Identity scaffold

`l1/config/public-testnet-identity.json` is an unfilled proposal:

- `status` is `proposal-unfilled`
- `chainId`, `genesisHash`, and `genesisTimestampMs` are null
- `bootstrapPeers` and `publicRpcEndpoints` are empty
- `activationAllowed`, `publicMiningActivated`, and `publicationAllowed` are false inside the file and the parser rejects `true`

`l1/config/public-testnet-governance-input.candidate.json` records the governance candidate `Zyron Public Testnet` / `zyron-public-testnet-1` with protocol genesis version 1 and quorum-delayed protocol v5. Validator, bootstrap, RPC, archive, monitoring, timestamp, and allocation fields stay empty, so genesis build remains fail-closed. That file is not an official genesis and it does not fill the identity proposal above. Operator steps are in [`PUBLIC_TESTNET_OPERATOR_GUIDE.md`](PUBLIC_TESTNET_OPERATOR_GUIDE.md).

`zyron-l1 node --network-class public-testnet` loads `l1/config/public-testnet-identity.json` plus `docs/l1-launch-authorization.json` and refuses to open a data directory unless all of the following hold:

1. status is `identity-frozen` (not the checked-in placeholder);
2. chain ID matches `zyron-public-testnet-<label>`, is at most 64 characters, and does not contain `mainnet`;
3. the supplied genesis chain ID, genesis-block hash, and timestamp match the proposal;
4. at least three bootstrap peers sit in at least three distinct failure domains, on public IPs or public `dns4`/`dns6` names;
5. at least two distinct HTTPS RPC origins are listed, with no loopback, credentials, path, query, or fragment;
6. `publicTestnetActivationAllowed` is true and `mainnetActivationAllowed` is false in the separate launch-authorization file.

The checked-in files fail step 1 and step 6. Forging only the launch flag still fails, because the placeholder has no chain ID or genesis hash. `--network-class mainnet` is rejected so this command cannot invent a mainnet identity. Omitting `--network-class` leaves the existing local and private node path unchanged, including `npm run devnet` and `npm run mine:local`.

Filling the proposal in a later reviewed change is not activation. Activation remains `publicTestnetActivationAllowed` in the launch-authorization file, which this scaffold does not set.

## Bootstrap scaffold

`l1/config/public-testnet-bootstrap.json` is a separate non-live proposal with exactly three slots, `bootstrap-a`, `bootstrap-b`, and `bootstrap-c`. Every failure domain, peer ID, and multiaddr is the token `PLACEHOLDER`. `live` is false, and the parser rejects `true`. The file names `ZYRON_PUBLIC_TESTNET_BOOTSTRAP_{A,B,C}_*` variables so a later review knows where real values would go. This process does not read those variables. A loopback or public address placed in the environment cannot replace `PLACEHOLDER`.

`--network-class public-testnet` also requires `--public-testnet-bootstrap`. The checked-in file adds `bootstrap-unfilled` and `bootstrap-not-dialable` to the refusal, and the dial target list stays empty. A structurally complete in-memory file with three distinct failure domains is still not dialed, because this file is not allowed to mark itself live. No production IP address or DNS name is published.

## Public RPC scaffold

`l1/config/public-testnet-rpc.json` keeps the public role disabled. Bind hosts and both HTTPS origins are `PLACEHOLDER`. The documented variables `ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_A`, `ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_ORIGIN_B`, `ZYRON_PUBLIC_TESTNET_PUBLIC_RPC_PORT`, and `ZYRON_PUBLIC_TESTNET_VALIDATOR_RPC_PORT` are not read. The parser rejects `live: true`, a real URL, and any limit above the pinned public ceilings.

The public role, if selected in process with `rpcRole: "public"`, serves `/status`, `/protocol`, `/healthz`, `/readyz`, `/rpc-info`, `/balance/*`, `/nonce/*`, and `POST /tx`. It refuses `/proposal/attest`, `/round/skip`, `/block`, `/blocks`, `/metrics`, `/peers`, and `/peer-record`. Its ceilings are 60 requests per 60 seconds, 64 KiB bodies, 5 second header and request timeouts, 64 connections, and 16 inflight requests. Those are stricter than the combined validator RPC defaults. The checked-in proposal still does not bind a listener. Local nodes keep the combined server.

## Architecture (canonical `l1/`)

| Question | What the code does | Gap for a real public testnet |
|---|---|---|
| Node boot | `zyron-l1 node --genesis --data` defaults to `127.0.0.1:9137`. `ChainStore.open` replays the data directory and rejects a stored chain ID or genesis hash that does not match the genesis file. | Boot accepts any well-formed genesis. Nothing persistent names "the" public testnet unless `--network-class public-testnet` is passed, and that path currently fail-closes. |
| Peer discovery | Configured `--p2p-peer` multiaddrs are pinned. Discovery exchanges bounded hints over Noise; callers must dial and complete the chain-identity handshake before admission. Failure-domain labels are operator-supplied. | The checked-in bootstrap file has three placeholder slots and zero dial targets. Real independent failure domains are still unpublished. |
| RPC auth and rate limit | Non-loopback bind requires consensus authentication and at least one `--rpc-trusted-proxy`, and forwarded protocol must be exactly `https`. Fixed-window limits cap tracked client identities and share one overflow quota. The public role adds stricter ceilings and refuses consensus routes. | No public listener is bound. Origins remain `PLACEHOLDER`. |
| Consensus vs public RPC | Validator consensus uses authenticated HTTP peers and/or Noise P2P. A `public` RPC role refuses attest, skip, block, block sync, metrics, and peer routes. | The checked-in proposal does not start that role. Local nodes still use the combined server. |
| Genesis and chain ID | Chain ID must match `^[a-z0-9-]{3,64}$`. Genesis hash is the genesis block hash. Restart identity is the stored chain ID plus that hash. `npm run devnet` mints `zyron-local-<hex>` and does not resume. | No immutable public-testnet chain ID or genesis hash is published. `zyron-devnet-1` is a CLI example. `zyron-render-private-testnet-1` is a private rehearsal. |
| Protocol upgrade and v5 | Height 0 is protocol 1. Supported versions are 1, 2, 3, and 5. Protocol 4 fails closed. A v5 schedule needs >2/3 active-validator approval and at least `MIN_PROTOCOL_UPDATE_DELAY` (100) blocks of delay. | Local `mine:local` can schedule v5 on a disposable chain. That does not activate public mining. |
| Claim flow | Miners sign locally from an encrypted keystore and submit one tip-bound `mining_claim`. A block accepts at most one valid claim. Stale previous-hash claims are rejected. The consensus tracker address `ZYN` + 40 zeroes counts finalized claims and has no spend key. | Public claim submission has nowhere persistent to go. |
| Contention | The mempool keeps the strongest eligible claim for the single mining slot. | No heterogeneous multi-miner contention evidence. The 20-bit target is not calibrated. |
| Rewards and nonce | See the economics section. Claim nonce is the miner account nonce. The tracker nonce is the claim counter. | Economics are implemented and pinned by tests. They are not a frozen public-testnet or mainnet policy beyond the code. |
| Wallet custody | Keystores are scrypt + AES-256-GCM. The miner refuses plaintext private keys. Password files stay on the miner machine. | Production validator custody still requires HSM or an audited remote signer. Remote signer support exists; production evidence does not. |
| HTTPS | Remote miner RPC must be HTTPS. Plain HTTP is accepted only for loopback. Public-testnet RPC origins in a frozen identity must be HTTPS. | No public certificate or hostname is published. |
| Finality | Quorum is `floor(2N/3)+1` distinct validator signatures. Skip certificates are deadline-gated. A round can also advance with an uncommitted-round certificate assembled from existing attestations and skips when no hash reaches the Byzantine-safe reveal threshold. Mining hash power does not choose the canonical chain. | Two-validator attest/skip splits can finalize on the next round. A 4- or 7-validator round-0 split completes the original block when exactly one hash could still reach quorum. Two hashes that could both still reach quorum stay stuck. Draft PR #898 documented the deadlock and did not ship this recovery. |
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

P0 items block a shared, persistent public testnet or public mining. Identity and bootstrap scaffolds exist and fail closed. They close no activation gate.

| Priority | Blocker | State after this change |
|---|---|---|
| P0 | Persistent public-testnet chain ID, genesis hash, timestamp, and reviewed genesis file | Scaffold exists and fail-closes. Values are still null |
| P0 | Bootstrap peers in at least three independent failure domains, plus archive and monitoring on independent domains | Placeholder scaffold exists and is not dialable. No real peers, archive, or monitoring are published |
| P0 | At least two distinct HTTPS public RPC endpoints, separate from validator consensus RPC | Public role and stricter limits exist. Origins are `PLACEHOLDER` and the role is not bound |
| P0 | `publicTestnetActivationAllowed` and the 10 requirements in `l1-launch-authorization.json` (issue #260) | Unchanged and false |
| P0 | `miner-network-profile.json` `publicMiningActivated` plus chain, genesis, and RPC | Unchanged: false and null |
| P0 | Multi-validator split-vote liveness for sets where one visible attestation is indistinguishable from a hidden quorum | Two-validator local rehearsal can recover without lowering quorum or erasing journals. Four- and seven-validator `Q-1` splits remain open |
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

**10** requirements in `publicTestnetActivationRequirements` remain open. The identity, bootstrap, and public-RPC scaffolds close none of them. The deployment runbook and `npm run public-testnet:preflight` also close none of them: engineering readiness can be PASS while governance activation stays BLOCKED.

Engineering P0s that still block a real shared public testnet:

1. Identity values are still null.
2. Bootstrap slots are still `PLACEHOLDER`, so no independent failure domain is published.
3. Public RPC origins are still `PLACEHOLDER`, so no public listener is bound.
4. A round where two different hashes could both still reach quorum stays stuck. Unique round-0 attest/skip splits for 4 and 7 validators can complete the original block. There is no prepare/commit view-change, and a split after round 0 is not completed. That does not activate a public testnet.

`publicMiningActivated` stays false. A later edit may replace placeholder bootstrap tokens. That edit still must not mark the file `live`, invent production endpoints, or set `publicTestnetActivationAllowed`, `mainnetActivationAllowed`, `publicMiningActivated`, or `publicationAllowed`.
