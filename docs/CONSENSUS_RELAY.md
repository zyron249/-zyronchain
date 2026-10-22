# Open testnet consensus relay (outbound-only external validators)

> **TESTNET ONLY. Not audited.** Design status: IMPLEMENTED — INDEPENDENT RETEST PENDING once the implementation PR merges. This document is a self-review / AI-assisted design, not an audit.

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
- A hosted node's consensus `POST` to the mailbox is queued for that external peer. If the peer has not polled in the last 10 s the mailbox answers `503` immediately, so an absent external peer costs the hosted round nothing beyond one loopback round trip. Otherwise it waits up to 6 s (below the node's 8 s deadline) for the reply, and answers `504` on timeout. `/block` (fire-and-forget) is acknowledged `202` at once.
- Allowed paths: `/v6/prepare`, `/v6/commit`, `/v6/timeout`, `/v6/block`, `/block`. Read paths (`/status`, `/blocks`) on the mailbox are served from the hosted nodes so the node's peer bookkeeping keeps working. Anything else is `404`.
- The external **relay client** (`scripts/consensus-relay-client.mjs`) long-polls `POST /relay/v1/poll` on the public gateway, replays each request against its own node on loopback, and returns the node's reply with `POST /relay/v1/reply`.

### 3.2 Outbound direction (external validator as leader → hosted validators)

- The relay client also serves a loopback HTTP endpoint that the external node uses as its peers: `--peer http://127.0.0.1:<client>/h/<i>` for each hosted validator. `POST`s on the consensus paths are sent to `POST /relay/v1/forward` with the target index; the gateway forwards to that hosted node on loopback and returns its reply verbatim. `GET /status` and `GET /blocks` go to the existing read-only `/peer/*` surface.

### 3.3 Transport authentication

- Each external peer has a dedicated **relay transport key** (secp256k1), separate from its validator key, so the relay client never needs the validator keystore. The gateway is configured with `ZYRON_RELAY_PEERS=<validatorAddress>=<relayPublicKey>,...` (at most 16 peers).
- Every relay request carries a JSON envelope `{ chainId, genesisHash, address, seq, issuedAtMs, op, bodyHash }` signed with `signCanonicalDomain("zyronchain/open-testnet-relay/v1", ...)`.
  - `chainId` and `genesisHash` must equal the gateway's: a wrong-chain envelope is rejected.
  - `issuedAtMs` must be within ±60 s of the gateway clock.
  - `seq` must be strictly greater than the last accepted `seq` for that address (replay protection; kept in memory, the ±60 s window bounds replays across gateway restarts).
  - `bodyHash` is the SHA-256 of the exact request body bytes; `op` is one of `poll`, `reply`, `forward`.
- Failures answer `401` with no detail beyond the reason class.

### 3.4 Limits

- Per peer: 600 relay requests/minute, at most 1 long-poll in flight, at most 32 queued requests (older ones are failed with `503` to the hosted caller), at most 8 forwards in flight.
- Size caps reuse the node's own: request bodies ≤ the node's consensus request caps (`MAX_BODY_BYTES` for `/v6/block` replies, 8 KiB for vote replies, 128 KB for timeout replies); a poll response ≤ 4 MB; anything larger is `413`.
- Unknown addresses are rate-limited per client IP like other public writes.

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
- First admission waits until at least **two** volunteer validators have relayed reliably (≥ 95 % of polls answered over 72 h as followers). Then admit the founder node and the volunteers in one `validator_update` (n = 7, quorum 5, margin 2). With all externals offline the chain would stall, so the update is only proposed once three external peers are healthy and any two of them keep the margin at 1 or more.
- Founder-operated nodes are always labelled as such and never count toward the independent-validator requirement.

## 5. Tests (failing first)

Adversarial tests on the gateway relay: forged envelope signature, unknown address, wrong `chainId`/`genesisHash`, stale and future `issuedAtMs`, replayed and non-increasing `seq`, wrong `bodyHash`, oversized bodies, disallowed paths on the mailbox and forward, mailbox `503` when the peer is absent, and an end-to-end round trip in which a vote relayed back is byte-identical to the one the external node produced.
