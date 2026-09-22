# Public testnet host hardening

Status: template. Public testnet is not launched. These steps apply to operator hosts after real keys, a governance timestamp, and real endpoints exist. They do not create those values.

Every role runs as an unprivileged `zyron` user. Consensus and signer sockets stay on the private network. Metrics stay on the monitoring path.

## Shared

- Install Node.js 22 or newer from the operator's own package source.
- One data directory per process, mode `0700`, owned by `zyron`.
- Keystores mode `0600`. Do not log, print, or commit private keys.
- Refuse symlink or junction paths for keystores and password files.
- Enable unattended security updates for the OS, not for unsigned chain binaries.
- SSH is key-only, from an operator bastion. No password login.
- Time sync is required. Genesis timestamps are governance values, not the host clock at build time.
- Back up the whole data directory. Do not delete the signing journal to "reset" a validator.

## Validator (`validator-a`, `validator-b`, `validator-c`)

- Bind consensus HTTP and P2P only on the private interface.
- The signer key never leaves this host. Remote signers, if used later, are a separate operator decision and are not configured here.
- Firewall: deny the public internet to consensus and signer ports.
- Restart the same binary against the same genesis and the same data directory.
- A restart that would require a new genesis is a rollback failure. Stop.

## Bootstrap (`bootstrap-a`, `bootstrap-b`, `bootstrap-c`)

- Publish one assigned P2P port only. Every other inbound port stays closed.
- Do not serve consensus routes.
- Peer ID and multiaddr come from the operator's generated public identity plus the operator's real address. Placeholder multiaddrs are not official.

## Public RPC (`rpc-a`, `rpc-b`)

- TLS terminates at Nginx or Caddy. Minimum TLS 1.2. Prefer TLS 1.3.
- Certificates are installed by the operator and are not stored in this repository.
- Proxy only the public role. Deny `/proposal/attest`, `/round/skip`, `/round/lock`, `/round/report`, `/round/complete`, `/block`, and `/metrics`.
- Set `X-Forwarded-For` from the proxy's own view of the client. The node trusts that header only when the TCP peer is the configured proxy.
- Body, header, and proxy timeouts stay bounded. See `l1/deploy/public-testnet/tls/`.

## Archive (`archive-a`)

- No signing key.
- Sync from validators over the private network.
- Do not expose consensus or metrics to the internet.

## Monitoring (`monitoring-a`)

- Scrape metrics over the private network only.
- Critical alerts: finality stall, divergent finalized hash, quorum loss, chain-id or genesis mismatch, signing-failure burst, state corruption, total public-RPC outage, all bootstraps down, reward or supply mismatch.
- A supply or reward mismatch is a stop. Do not keep serving that tip as healthy.
