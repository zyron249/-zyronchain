# Open testnet consensus relay (outbound-only external validators)

> **TESTNET ONLY. Not audited.** Design status: PROPOSED. It becomes IMPLEMENTED — INDEPENDENT RETEST PENDING when the implementation (`scripts/open-testnet/consensus-relay.mjs`, `scripts/consensus-relay-client.mjs`) is on `main`. This document is a self-review / AI-assisted design, not an audit.

## 1. Problem

The hosted open testnet runs four v6 validators on loopback behind one public HTTPS gateway (`scripts/open-testnet.mjs`). v6 consensus over HTTP is request/response: the round leader `POST`s `/v6/prepare`, `/v6/commit`, `/v6/timeout`, `/v6/block` and `/block` to every peer and collects the signed votes in the replies (8 s deadline). An external validator behind NAT, or on a machine that can pause, has no inbound endpoint, so the leaders cannot call it and it cannot be admitted.

## 2. Goal and non-goals

- Let an allowlisted external validator take part in v6 consensus using **outbound HTTPS only**, through the existing Render port.
- The relay is **untrusted transport**. It never holds or uses an external validator's key and never creates, alters or aggregates votes. Every vote and certificate is verified by the receiving node's existing v6 rules (membership, signature, height/round, QC checks). A relay that drops, delays, reorders, replays or forges messages can at most slow or stall the rounds it carries; it cannot make a node accept an invalid vote.
- No change to consensus rules, quorum math, supply, allocations or genesis.
- Non-goals: a general P2P network; value-bearing networks (they use native P2P, `docs/V6_OPERATOR_GUIDE.md`).

## 3. Design

### 3.1 Inbound direction (hosted leader → external validator)

- For each configured external peer the gateway runs a **mailbox** on a separate loopback-only listener (`127.0.0.1:<basePort+50>`, never the public port). Each hosted validator gets `--peer http://127.0.0.1:<mailbox>/x/<address>` in addition to its loopback peers.
- Consensus `POST`s reach a peer's mailbox only while that address is a validator at the **next or next-but-one height** of the gateway's verified history. That history is extended from the live hosted chain every 5 s while the relay is on (not only by snapshot builds), with full finalized-block validation; updates are scheduled at least 100 blocks ahead, so an activation at height H is known while the nodes are still at H-1 collecting votes for H. For an allowlisted candidate that is not yet active the mailbox answers `503` at once, so candidates never hold one of the hosted collector's worker slots or its 8 s deadline.
- A hosted node's consensus `POST` to the mailbox is queued for that external peer. If the peer has not polled in the last 10 s the mailbox answers `503` immediately, so an absent external peer costs the hosted round nothing beyond one loopback round trip. Otherwise it waits up to 6 s (below the node's 8 s deadline) for the reply, and answers `504` on timeout. `/block` (fire-and-forget) is acknowledged `202` at once.
- Allowed paths: `/v6/prepare`, `/v6/commit`, `/v6/timeout`, `/v6/block`, `/block`. Reads `GET /status` and `GET /blocks?from=` are relayed to the external peer too (`limit` capped at 2 blocks), so after a hosted snapshot restore that lost recent blocks the hosted nodes can sync forward from an external validator's durable history; every block is fully validated by the reader as in any peer sync. Anything else is `404`.
- The external **relay client** (`scripts/consensus-relay-client.mjs`) long-polls `POST /relay/v1/poll` on the public gateway, replays each request against its own node on loopback, and returns the node's reply with `POST /relay/v1/reply`.

### 3.2 Outbound direction (external validator as leader → hosted validators)

- The relay client also serves a loopback HTTP endpoint that the external node uses as its peers: `--peer http://127.0.0.1:<client>/h/<i>` for each hosted validator. `POST`s on the consensus paths are sent to `POST /relay/v1/forward` with the target index; the gateway forwards to that hosted node on loopback and returns its reply verbatim. `GET /status` and `GET /blocks` go to the existing read-only `/peer/*` surface. `/relay/v1/forward` is accepted only under the same height-aware membership rule (`403` otherwise), so an allowlisted candidate cannot spend forward slots or hosted-node work before admission; candidates may still `poll` (to prove reachability) and serve relayed reads.

### 3.3 Transport authentication

- Each external peer has a dedicated **relay transport key** (secp256k1), separate from its validator key, so the relay client never needs the validator keystore. The gateway is configured with `ZYRON_RELAY_PEERS=<validatorAddress>=<relayPublicKey>,...` (at most 16 peers).
- Every relay request carries a JSON envelope `{ chainId, genesisHash, address, seq, issuedAtMs, op, bodyHash }` signed with `signCanonicalDomain("zyronchain/open-testnet-relay/v1", ...)`.
  - `chainId` and `genesisHash` must equal the gateway's: a wrong-chain envelope is rejected.
  - `issuedAtMs` must be within ±60 s of the gateway clock.
  - `seq` must not repeat any `seq` accepted for that address within the last 130 s (replay protection for concurrent requests). Across gateway restarts: with `ZYRON_RELAY_SEEN_FILE=<path>` the accepted `(address, seq)` set is appended and fsynced to a private journal before the request is acted on, reloaded on start, pruned to the 130 s window and 20,000 entries per peer, and compacted by atomic rewrite, so its size stays bounded; a `<path>.lock` held by a live process stops a second gateway from sharing it. Without a journal, the gateway refuses envelopes with `issuedAtMs` earlier than its start time + 60 s, which covers everything a previous process could have accepted (external peers are paused for up to 60 s after a restart). Gateways on separate hosts do not share replay state: run one gateway per relay peer set. The client uses microsecond timestamps plus a counter.
  - `bodyHash` is the SHA-256 of the exact request body bytes; `op` is one of `poll`, `reply`, `forward`.
- Failures answer `401` with no detail beyond the reason class.

### 3.4 Limits

- Per peer: 600 relay requests/minute, at most 1 long-poll in flight, at most 32 queued requests (older ones are failed with `503` to the hosted caller), at most 8 forwards in flight.
- Request and reply caps are separate. Consensus **request** bodies (a v6 prepare can carry a whole block): ≤ 2.7 MB, above the node's own 2.5 MB `MAX_BODY_BYTES`. **Reply** bodies, per path, mirror the node's peer response caps: 8 KiB for prepare/commit votes, 128 KB for timeouts, 2.6 MB for `/v6/block`, 64 KB for `/status`, 5.4 MB for 2 blocks. A relay HTTP body is ≤ 8 MB and a poll response ≤ 4 MB of queued requests (at least one is always delivered). Anything larger is `413`.
- Unknown addresses are rate-limited per client IP like other public writes.
- **Pre-authentication limit:** failed signature checks are counted per client IP (20 per minute); above that the client gets `429` before any further signature verification. Forged requests that claim a configured address are never charged to that peer's own quota, so an attacker cannot exhaust a legitimate relay client's budget; secp256k1 work per IP is bounded by this limit and the gateway's per-IP relay limit.
- **Per-target isolation:** the hosted nodes see all gateway traffic under one loopback identity with a consensus in-flight limit of 4. Forwards into one hosted node are capped at 2 in flight across all external peers, and 1 per external peer, so a faulty admitted validator cannot occupy the slots the hosted validators need for each other.

### 3.5 What the relay can and cannot do

| Relay misbehaviour | Effect |
|---|---|
| Forges or alters a vote | Rejected by the receiving node's signature check. |
| Replays an old vote | Rejected by v6 height/round/QC rules (and a replayed envelope by `seq`). |
| Drops or delays | The external validator counts as absent for that round; liveness as in §4. |
| Sends a vote to the wrong chain | Rejected: votes are domain-separated by chain and the envelope binds the genesis hash. |

The gateway operator already runs the hosted validators, so the relay adds no new trusted party.

## 4. Liveness and admission plan

BFT quorum is `floor(2n/3)+1`; fault margin `f = floor((n-1)/3)`.

| Set | Quorum | Margin | Hosted-only quorum? | Margin while the founder node is paused |
|---|---|---|---|---|
| 4 hosted (today) | 3 | 1 | yes | 1 |
| 4 hosted + founder node | 4 | 1 | yes (4 of 4) | **0** |
| 4 hosted + founder + 1 volunteer | 5 | 1 | **no** | 0 |
| 4 hosted + founder + 2 volunteers | 5 | 2 | **no** (needs one external) | 1 |

Decision:

- The founder-operated node is **not** admitted alone: with it paused (the host can pause) the network would have no fault margin, which is below today.
- First admission waits until at least **two** volunteer validators have relayed reliably: ≥ 95 % of relayed consensus exchanges completed with a `/reply` from their own node (not just polls answered) over 72 h, measured with the candidates temporarily counted as voting peers on a rehearsal chain, since the live mailbox does not send consensus requests to inactive peers. Then admit the founder node and the volunteers in one `validator_update` (n = 7, quorum 5, margin 2). With all externals offline the chain would stall, so the update is only proposed once three external peers are healthy and any two of them keep the margin at 1 or more.
- Before that `validator_update`, the gateway's `/health` and `/readyz` must derive quorum from the **active** validator set (not `genesis.validators.length` and the four hosted names) and count reachable external validators; otherwise health could report ready while the chain cannot finalize. This is a prerequisite PR.
- Founder-operated nodes are always labelled as such and never count toward the independent-validator requirement.

## 5. Tests (failing first)

Adversarial tests on the gateway relay: forged envelope signature, unknown address, wrong `chainId`/`genesisHash`, stale and future `issuedAtMs`, replayed `seq` (an already-seen value, or one below the replay window; unseen out-of-order values inside the window are accepted), wrong `bodyHash`, oversized bodies, disallowed paths on the mailbox and forward, mailbox `503` when the peer is absent, and an end-to-end round trip in which a vote relayed back is byte-identical to the one the external node produced.
