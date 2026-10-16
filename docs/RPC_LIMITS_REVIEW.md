# RPC limits review (P1-02)

Scope: the node RPC server (`l1/src/node-base.ts`, `createRpcServer` and `route`) and the two public testnet gateways that front it (`l1/scripts/open-testnet.mjs`, deployed on Render as the open testnet, and `l1/scripts/public-testnet-rpc.mjs`, the wallet testnet RPC). Reviewed at `de73faf`. This is a code review with tests, not an audit, and it does not replace Internet-scale abuse testing of a real deployment.

## Node RPC: server-wide limits

| Limit | Value | Where |
| --- | --- | --- |
| Per-client fixed window (all routes, counted before routing and before any body is read) | 600 requests / 60 s (`requestsPerWindow`, `windowMs`) | `node-base.ts` `createRpcServer`, `rpc-rate-limit.ts` |
| Client identity | transport IP; behind an exact `--rpc-trusted-proxy` set, the first untrusted hop from the right of `X-Forwarded-For` (max 16 hops, 16 proxies); **IPv6 per /64** (this change) | `rpcRateLimitIdentityFromSet` |
| Tracked identities | 4,096; unseen identities beyond that share one overflow quota | `FixedWindowLimiter` |
| Concurrent requests (node-wide) | 128, then 503 | `RpcAdmissionController` |
| Connections | 256 (`server.maxConnections`) | `createRpcServer` |
| Requests per socket / headers | 100 / 64 headers | `RPC_MAX_REQUESTS_PER_SOCKET`, `RPC_MAX_HEADERS` |
| Timeouts | headers 10 s, request 15 s, keep-alive 5 s | `createRpcServer` |
| Request body | 2,500,000 bytes, declared or streamed; `application/json` only; empty refused | `readJsonBody` |
| JSON complexity | nesting 64, structural tokens 250,000 (checked before `JSON.parse`) | `assertBoundedRpcJsonStructure` |
| In-flight request body bytes (node-wide) | 25,000,000 (+3x transient parse reservation) | `RpcRequestBodyByteBudget` |
| In-flight response bytes (node-wide) | 25,000,000 | `RpcResponseByteBudget` |
| Non-loopback bind | refused unless consensus peer authentication and an HTTPS trusted proxy are configured | `assertSafeRpcBinding` |

## Node RPC: per route

| Route | Auth | Body cap | Response cap | Rate limit | CPU / cost |
| --- | --- | --- | --- | --- | --- |
| `GET /rpc-info`, `/status`, `/protocol`, `/healthz` | none | n/a | 4 MB serialization bound | per-client window | constant |
| `GET /readyz`, `/metrics` | none | n/a | 4 MB | per-client window | constant; `/metrics` exposes operational counters, no secrets |
| `GET /peer-record`, `/peers?limit=` (only when configured) | none | n/a | 4 MB; `limit` <= discovery maximum | per-client window | bounded list |
| `GET /blocks?from=&limit=` | none | n/a | 25 MB; `limit` 1..100; payload <= 20 MB | per-client window | disk read of <= 100 finalized blocks |
| `GET /balance/:address`, `/nonce/:address` | none | n/a | 4 MB | per-client window | address validated, map lookup |
| `POST /tx` | none (public submit) | 2.5 MB | 4 MB | per-client window (counted before the body is read) | shape check, nonce window (64), mempool admission and, for the next nonce, full signature and state validation |
| `POST /proposal/attest`, `/round/skip`, `/block`, `/v6/prepare`, `/v6/commit`, `/v6/timeout`, `/v6/block` | consensus peer auth (bearer token or signed peer request), checked before the body is read; then 4 in flight per peer | 2.5 MB | 4 MB (`/v6/timeout` 256 KB, `/v6/block` 2.564 MB) | per-client window + per-peer in-flight | block / vote validation |
| anything else | none | n/a | small | per-client window | 404 |

There are no admin routes on the node RPC: key, governance and recovery operations are CLI-only (`cli.ts`). The remote signer (`remote-signer-service.ts`) is a separate loopback/TLS service with a mandatory bearer token and a bounded body.

## Public testnet gateways

| | `open-testnet.mjs` (Render open testnet) | `public-testnet-rpc.mjs` (wallet testnet) |
| --- | --- | --- |
| Exposed | reads (`/status`, `/network`, `/genesis`, `/blocks` <= 20, `/block/:h`, `/balance`, `/nonce`, `/account`), read-only peer surface (`/peer/status`, `/peer/blocks` <= 100), `POST /tx` (transfers only), `POST /faucet`, sealed `/state/snapshot` | reads, `POST /tx` (transfers only), `POST /faucet` |
| Not exposed | validator consensus routes, `/metrics`, `/peers` | same |
| Reads | 240 / min per client | 120 / min per client |
| `POST /tx` | 10 / min per client, counted before the body is read | 10 / min per client |
| Faucet | 5 / day per client, 1 / day per address, 200 / hour global | same |
| Snapshot | 30 / hour global | n/a |
| Body | 8 KB, `application/json` | 8 KB |
| Concurrency / connections | 64 active requests / 256 connections | 64 active requests / 256 connections |
| Timeouts | headers 5 s, request 10 s, keep-alive 5 s; URL <= 256 chars | headers 5 s, request 10 s, keep-alive 5 s |

## Findings

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| P1-02-M1 | Medium (availability) | Node RPC bucketed IPv6 clients per /128. One /64 (a single end site) could open 4,096 tracked identities with a full quota each and then exhaust the shared overflow quota, so every new client was refused for the rest of the window. Witness at `de73faf`: 5,000 hosts of one /64 against the default 600/min limiter got 4,696 requests through and the next unrelated client was refused. | Fixed in this PR: IPv6 clients share one bucket per /64 (`rpc-client-identity.ts`); the same /64 now gets 600 and an unrelated client keeps its full quota. |
| P1-02-M2 | Medium (availability, abuse) | The public gateways took the client identity from the **leftmost** `X-Forwarded-For` entry, which the client writes. `open-testnet.mjs` trusted it from a loopback tunnel and `public-testnet-rpc.mjs` with `ZYRON_TRUST_PROXY=1`, so a client could rotate identities to bypass the per-client read, submit and faucet limits, and could fill a limiter's 50,000-key table so that new clients were refused. On Render, where the gateway sees the platform proxy and not a loopback peer, `open-testnet.mjs` instead bucketed every client under the proxy's address, so one heavy client could exhaust the shared quota (including the 5-per-day faucet limit) for everyone behind that proxy. | Fixed in this PR: `gatewayClientIdentity` uses `CF-Connecting-IP` only when the operator declares a Cloudflare edge (`ZYRON_TRUST_CF_CONNECTING_IP=1`, set in `deploy/open-testnet/render.yaml`; `ZYRON_TRUST_PROXY=1` for the wallet RPC), otherwise the rightmost entry appended by a loopback proxy, and never the leftmost entry; malformed or missing values fail closed to the proxy's shared bucket; IPv6 per /64. |
| P1-02-L1 | Low | `GET /health` on the open-testnet gateway is not rate limited (the platform health check uses it) and fans out one `/status` call to each of the four loopback validators per request. Concurrency is capped at 64 active requests, so the cost is bounded but not cached. | Open. Suggested: cache the validator status for about 1 s. |
| P1-02-L2 | Low | Node RPC `POST /tx` has no submit-specific limit below the 600/min per-client window; each next-nonce submission runs full signature and state validation. Not reachable on the public testnet (the gateway allows 10/min and validators bind to loopback), but relevant to anyone exposing a node RPC through a trusted proxy. | Open. Suggested: an optional per-client submit window. |
| P1-02-L3 | Low | The aggregate response budget (25 MB) equals the `/blocks` response cap, so one slow reader holding a large `/blocks` response can make other responses fail with 503 until it finishes. Bounded by the 15 s request timeout and today's small blocks. | Accepted risk, documented. |
| P1-02-I1 | Info | `/metrics` and `/peers` are public on the node RPC. They carry operational counters and signed peer records, no secrets. The public gateways do not expose them. | Accepted, documented. |
| P1-02-I2 | Info | IPv6 /64 bucketing still lets a holder of a /48 or /56 use 2^16 or 2^8 buckets. The tracked-identity cap and shared overflow quota bound the memory; edge rate limiting (Cloudflare) remains the outer layer. | Accepted, documented. |

## Tests

- `l1/test/rpc-client-identity.test.ts`: node RPC IPv6 /64 bucketing (direct and through a trusted proxy), IPv4 unchanged, one /64 cannot multiply its quota or fill the identity table, IP-literal parsing, and gateway identity (direct client ignores headers, leftmost `X-Forwarded-For` never used, client-supplied `CF-Connecting-IP` ignored unless trusted, Cloudflare mode, fail-closed fallbacks, oversized headers).
- `l1/test/rpc-limits-boundary.test.ts`: request body exactly at the cap accepted for parsing and one byte over refused (declared and streamed), Content-Type and empty body, `/blocks` limit 100 accepted and 101/0 refused, the per-client window at its exact boundary (including `POST /tx`), and consensus routes refusing unauthenticated callers before reading the body.
- Existing: `rpc-rate-limit-cardinality.test.ts`, `rpc-proxy-rate-limit-identity.test.ts`, `rpc-json-parse-budget.test.ts`, `l1.test.ts` (limits, timeouts, auth), and the open-testnet and wallet RPC smoke tests.

Not checked: Render's and Cloudflare's actual header behaviour on the live service (documented platform behaviour only), and load or abuse testing against a real deployment.
