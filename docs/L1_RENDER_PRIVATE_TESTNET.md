# ZyronChain Render private testnet

Status: **ephemeral, non-value-bearing private testnet deployment profile**.

This profile exists to exercise the canonical TypeScript L1 on live cloud infrastructure without bypassing the repository's public-testnet or mainnet gates.

## What it runs

`l1/scripts/render-private-testnet.mjs` starts four independent ZyronChain validator **processes** inside one Render service instance. Each process has its own runtime-generated secp256k1 validator key, data directory, signing journal and loopback RPC port. The validators use the canonical HTTP peer/consensus client over `127.0.0.1` and therefore execute the same proposal, attestation, finality, persistence and replay code as the standalone node.

The launcher creates a fresh deterministic-valid genesis structure at each service start with:

- chain ID `zyron-render-private-testnet-1` by default;
- four runtime-generated validators;
- one runtime-generated activity-oracle public key;
- a runtime-generated activity-pool address;
- exactly 1 test ZYN allocated to each validator and 1 test ZYN to the activity pool.

These balances have **no promised or intended monetary value**. The testnet does not change the 50M maximum-supply invariant and does not define mainnet allocation, validator rewards, inflation, oracle governance or validator-admission policy.

## Exposure model

Validator RPC binds only to loopback. Render's public `PORT` is owned by a separate read-only gateway.

Public gateway methods:

- `GET /`
- `GET /status`
- `GET /healthz`
- `GET /readyz`

All non-GET requests return `405`. The gateway does not expose transaction submission, block acceptance, proposal-attestation, round-skip, validator governance or protocol-governance writes.

The status response explicitly reports:

- `mode: ephemeral-private-testnet`;
- `valueBearing: false`;
- `publicTestnetAuthorized: false`;
- `mainnetAuthorized: false`;
- four validator processes but only **one infrastructure failure domain**;
- current genesis hash, height range and exact-tip convergence.

## Persistence and restart semantics

Unless `ZYRON_TESTNET_DATA_ROOT` is explicitly supplied by an operator, all validator keys, genesis and chain data live on the runtime filesystem and are removed on clean shutdown. A Render redeploy/restart therefore creates a **new testnet genesis**.

This is intentional for the first live infrastructure rehearsal. It avoids inventing production custody or pretending an ephemeral Render filesystem is durable consensus storage.

Do not use this profile as a persistent public network. A durable multi-host testnet requires independently controlled validator hosts, persistent storage, independently preserved genesis/checkpoint evidence and the public-testnet gates in `STANDALONE_L1_READINESS.md`.

## CI smoke gate

`Standalone L1 Render Private Testnet Smoke CI` builds the current canonical L1, launches the four-validator profile, and requires:

1. all four validator processes to become ready;
2. at least two blocks to be finalized by the validators' normal 30-second consensus loop;
3. all four nodes to converge to the exact same finalized height and tip hash;
4. the launcher to retain `publicTestnetAuthorized=false`, `mainnetAuthorized=false` and `valueBearing=false`.

The smoke test does not inject finalized blocks manually.

## Render deployment

Recommended initial service profile:

- runtime: Node.js;
- branch: `main`;
- build: `cd l1 && npm ci && npm run build`;
- start: `cd l1 && node scripts/render-private-testnet.mjs`;
- region: Ohio;
- auto-deploy: off, because a deploy intentionally resets the ephemeral network;
- instance: Starter or larger; four Node validator processes run in one instance.

This single-instance topology is **not** independent-operator or multi-region evidence. It is a live private testnet rehearsal only.
