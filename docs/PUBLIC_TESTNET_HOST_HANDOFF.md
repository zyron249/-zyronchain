# Public testnet host handoff

Public testnet is not launched. Fill `l1/config/public-testnet-hosts.operator.json` from the example only after real hosts exist. Do not commit that file. Domains go in `l1/config/public-testnet-domains.operator.json`, also uncommitted.

`npm run public-testnet:config-check` prints the empty summary. `npm run public-testnet:install-dry-run` does not create keys or start a process. `npm run public-testnet:host-preflight -- --role validator` checks the template. Pass `--data` only for a real directory.

## Per role

| Role | Before start |
|---|---|
| validator-a/b/c | Isolated host, persistent disk, validator keystore mode 0600, genesis file, private consensus bind, backup of data and journal |
| bootstrap-a/b/c | Bootstrap keystore, real peer ID, real multiaddr, one public P2P port, no validator key |
| rpc-a/b | Public RPC role, TLS certificate installed on the proxy, no validator or bootstrap key, consensus paths denied |
| archive-a | Persistent disk, no signing key, restore test against the same genesis hash |
| monitoring-a | Private scrape path only, no validator key |

TLS checklist: certificate and key on the host, not in git; TLS 1.2 minimum and 1.3 preferred; no password in the unit file; renewal does not restart a validator with a new genesis.

Minimum layout is 7 hosts with the sharing in `l1/deploy/public-testnet/bom.json`. Recommended layout is 10 hosts, one role each. Terraform files under `l1/deploy/public-testnet/terraform/` are an interface sketch. Do not apply them.

Local multiprocess rehearsal is `npm run public-testnet:local-rehearsal -- --plan`. `--boot-check` starts three loopback validators on a disposable `zyron-local-multiprocess-rehearsal` chain. That is not the public testnet and not three cloud regions.
