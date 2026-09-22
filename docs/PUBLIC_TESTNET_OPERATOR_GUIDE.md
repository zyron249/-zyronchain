# Zyron Public Testnet operator guide

Status: **not launched**. This guide prepares operators. It does not activate the network.

Candidate identity, decided by governance and still awaiting operator input:

| Field | Value |
|---|---|
| Network name | Zyron Public Testnet |
| Chain ID | `zyron-public-testnet-1` |
| Validators | 3, weight 1 each (`validator-a`, `validator-b`, `validator-c`) |
| Genesis protocol | 1 |
| Protocol v5 | Later, by the existing quorum-delayed upgrade. Not forced at genesis |
| Regions | `region-a`, `region-b`, `region-c` (vendor-neutral names, not providers) |

`publicTestnetActivationAllowed`, `mainnetActivationAllowed`, `publicMiningActivated`, and `publicationAllowed` stay false. Mainnet is not derived from this chain ID.

Checked-in identity, bootstrap, and public RPC files stay unpublished. The candidate file `l1/config/public-testnet-governance-input.candidate.json` is not a genesis.

## What operators must supply

- Exact genesis timestamp in UTC milliseconds. The builder rejects a missing timestamp. It does not call `Date.now()`.
- Public keys for `validator-a`, `validator-b`, and `validator-c`, each weight 1.
- Activity oracle public key.
- Faucet, activity-pool, and operations addresses with explicit `amountAtoms`. No address or amount is invented here. Any non-zero allocation reduces the mining budget: `miningBudgetAtoms = 5_000_000_000 ZYN in atoms - genesis supply`. Founder, premine, and team purposes are rejected.
- Bootstrap public identities for `bootstrap-a`, `bootstrap-b`, and `bootstrap-c`: peer ID, multiaddr, and failure domain. Placeholder multiaddrs are not official.
- Public HTTPS names for two RPC origins, one archive endpoint, and one monitoring endpoint.
- Hosting regions and providers. The templates do not name a cloud vendor or an IP address.
- Separate activation authorization. Engineering readiness does not authorize launch.

## Provision keys

On the operator machine, not in this repository:

```sh
cd l1
npm run build
node scripts/provision-public-testnet-operator.mjs \
  --role validator --label validator-a \
  --dir /var/lib/zyron/keys --password-file /var/lib/zyron/password
node scripts/provision-public-testnet-operator.mjs \
  --role validator --label validator-a \
  --dir /var/lib/zyron/keys --export-public
```

Repeat for `validator-b`, `validator-c`, `bootstrap-a`, `bootstrap-b`, and `bootstrap-c`. Creation is exclusive, mode `0600`, and refuses an existing path or a symlink. The command prints the public record only: label, public key, address, node identity, and weight 1. It does not print a multiaddr.

## Genesis

When every operator field and the governance timestamp are present, build with `npm run public-testnet:genesis`. Until then the build fails closed. Two builds of the same approved input are byte-identical. Do not build a genesis from the example file or from the candidate file.

## Deploy templates

`l1/deploy/public-testnet/` holds systemd, Docker, Compose, cloud-init, env, nftables, Nginx, and Caddy templates. Compose publishes port 443 on the edge proxy only. Validator consensus is on an internal network. TLS material is operator-installed.

Host steps per role: `docs/PUBLIC_TESTNET_HOST_HARDENING.md`.

## Firewall

Internet to TCP 443 (public RPC): allow. Internet to validator consensus or signer: deny. Bootstrap P2P: only the assigned port. Miner to HTTPS RPC: allow. Miner to consensus: deny. Metrics: monitoring role on the private network only.

## Miners

Miners use the public HTTPS endpoints. They check `chainId` and `genesisHash` on every endpoint, fail over from RPC A to RPC B, drop stale work when the tip changes, and never send a private key. Backoff uses capped exponential delay plus deterministic jitter, and a short window refuses request spam.

Public mining stays inactive. Protocol v5 is rehearsed in private with genesis still at version 1 and with `MIN_PROTOCOL_UPDATE_DELAY` (100 blocks) intact.

## Observability and soak

Operator metrics use the `zyron_*` names in `l1/src/public-testnet-governance.ts`. The renderer refuses `exposure: "public"`. Critical alert names are listed beside the templates.

Soak horizons are 24h, 72h, and 7d. A pass requires finalized progress, one hash per height, no supply or reward mismatch, and successful failover or restart evidence. 72h and 7d also fail on unbounded RSS or database growth. 7d also fails when peers stay absent or RPC errors grow without height progress.

## Release artifacts

The pipeline plan lists Linux, macOS, and Windows, plus SHA256SUMS, SBOM, commit, and provenance. `publicationAllowed` is false. Do not publish.

## Freeze

`l1/config/PUBLIC-TESTNET-FREEZE.schema.json` is the manifest format. Status stays `format-only` with null genesis fields. Do not write an official freeze until a real genesis exists.

## Preflight

`npm run public-testnet:preflight` prints the network identity summary and exits 0 only when engineering is PASS, governance activation is BLOCKED, and the activation flags are false. Expected summary while operator input is missing: validators `0/3`, bootstraps `0/3`, public RPC `0/2`, archive `0/1`, monitoring `0/1`, regions `0/3`, genesis `NOT BUILT`, mining `INACTIVE`, authorization `BLOCKED`, deployment `NOT READY`.

## Rollback

Allowed: restart the same binary with the same genesis file and the same data directory.

Refused:

- Deleting or truncating signing journals.
- Regenerating genesis for an existing chain.
- Reusing `zyron-public-testnet-1` with a different genesis.

A wrong genesis is a different network. It needs a new chain ID and a new governance decision. It is not a rollback of this chain.
