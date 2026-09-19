# Public tester guide

Status: **local public test only**. There is **no hosted public L1 RPC**, explorer, faucet, or bootstrap peer list in this repository.

Governance authorization exists (`publicTestnetAuthorized=true` in [`l1-launch-authorization.json`](l1-launch-authorization.json)). Activation does not: `publicTestnetActivationAllowed=false`. Do not treat this guide as a live public testnet.

The only supported way for an external tester to exercise the **canonical** chain today is the loopback two-validator network in `l1/`.

## What you can test today

| Surface | What it is | How to run |
|---|---|---|
| Canonical L1 local public test | Two-validator PoA chain on `127.0.0.1`, disposable keys, verified 1 ZYN transfer | `cd l1 && npm ci && npm run devnet` |
| Automated local check | Same network plus quorum-loss, recovery, and restart | `cd l1 && npm run devnet:check` |
| Packaged miner (local) | Protocol-v5 issuance miner against **your** loopback RPC | [`l1/MINING.md`](../l1/MINING.md) |
| Website / wallet / validator pages | Static local-first setup assistants; they never hold secrets | `python3 -m http.server 8080 --directory website` |
| Legacy Python/Flask node | Archived compatibility testnet (`zyron-testnet-1`), not the canonical chain | [`LEGACY_PYTHON_TESTNET.md`](LEGACY_PYTHON_TESTNET.md) |

## What does not exist in this repository

- No published public wallet RPC, P2P bootstrap, explorer, or faucet for the TypeScript L1.
- No immutable public-testnet chain ID or genesis hash. `npm run devnet` generates a fresh `zyron-local-<hex>` identity every run.
- `zyron-devnet-1` appears only as a **local CLI example** in `l1/README.md`. It is not a live network.
- `zyron-render-private-testnet-1` is the default chain ID of the **ephemeral private Render rehearsal** ([`L1_RENDER_PRIVATE_TESTNET.md`](L1_RENDER_PRIVATE_TESTNET.md)). It is not a public testnet.
- The historical hostname `https://zyronchain.onrender.com` is quarantined. Do not use it as RPC, explorer, faucet, or bootstrap.
- ZyronChain is **not EVM**. MetaMask, Remix, and other Ethereum wallets cannot connect.

## Prerequisites

- Node.js 22 or 24
- Linux or macOS. On Windows use WSL2 and clone onto the Linux filesystem (`~/...`, not `/mnt/c`). Validators need POSIX directory fsync.
- About two minutes for the first block (30-second interval)

```sh
git clone https://github.com/zyron249/-zyronchain.git
cd -- -zyronchain/l1
npm ci
npm run typecheck
npm run devnet
```

`npm run devnet` builds the node, writes encrypted development keystores, starts two validators bound only to `127.0.0.1`, waits for finality, and submits a 1 ZYN transfer. Press Ctrl+C to stop. Details and Windows notes: [`l1/LOCAL_DEVNET.md`](../l1/LOCAL_DEVNET.md).

The launcher prints the random chain ID, both RPC URLs, the temporary data directory, funded addresses, and example `curl` / transfer commands. Those secrets are development-only (`0700` directory, `0600` keystores). Do not reuse them on any public network.

## Connect a wallet

There is no hosted wallet and no browser custody.

1. Leave `npm run devnet` running and note `chainId`, RPC URL, and the temporary directory.
2. In a second terminal, create an encrypted tester wallet **outside the repository**:

```sh
cd /path/to/-zyronchain/l1
umask 077
mkdir -p "$HOME/zyron-tester"
node dist/src/cli.js keygen \
  --out "$HOME/zyron-tester/wallet.json" \
  --password-file "$HOME/zyron-tester/wallet.password"
```

The command prints a `ZYN` + 40 hex address. The password file must be a regular file, mode `0600`, at least 12 characters, at most 1 KiB.

3. Fund that address from the disposable validator-A key printed by the launcher (1 ZYN = `100000000` atoms; fees burn):

```sh
export ZYRON_KEYSTORE_PASSWORD_FILE=/path/to/tmp/zyron-local-devnet-.../secrets/a.password
node dist/src/cli.js transfer \
  --key /path/to/tmp/zyron-local-devnet-.../secrets/a.json \
  --rpc http://127.0.0.1:<PORT_A> \
  --chain-id zyron-local-<hex> \
  --to ZYN<your-40-hex> \
  --amount-atoms 100000000 \
  --fee-atoms 1000
```

Replace the placeholders with the values the launcher printed. There is no public faucet; the only local source of atoms is genesis allocation (validator A starts with 1000 ZYN, the activity pool with 1000 ZYN).

## Inspect the local RPC

RPC binds to loopback. Useful read endpoints:

```sh
curl -s http://127.0.0.1:<PORT_A>/status
curl -s http://127.0.0.1:<PORT_A>/healthz
curl -s http://127.0.0.1:<PORT_A>/readyz
curl -s http://127.0.0.1:<PORT_A>/protocol
curl -s http://127.0.0.1:<PORT_A>/rpc-info
curl -s http://127.0.0.1:<PORT_A>/balance/ZYN<40-hex>
curl -s http://127.0.0.1:<PORT_A>/nonce/ZYN<40-hex>
```

`GET /status` returns `chainId`, `genesisHash`, `height`, and `tipHash`. Full method list: [`l1/README.md`](../l1/README.md) (RPC surface).

Do not expose validator RPC to the Internet. Non-loopback RPC fails closed unless consensus authentication and an exact `--rpc-trusted-proxy` are configured.

## Mine locally (optional)

Protocol v5 mining is issuance-only. Hash power does not choose the canonical fork. Public mining is not activated.

Against the local devnet you can point the packaged miner at loopback HTTP after creating an encrypted wallet. Follow [`l1/MINING.md`](../l1/MINING.md). Remote RPC must be HTTPS; plaintext HTTP is accepted only on loopback. The local launcher's genesis is **not** protocol-v5-activated by default; mining claims will not finalize unless that network actually has protocol v5 scheduled.

## Environment and secrets

Copy [`.env.example`](../.env.example) only as a checklist. The node does **not** auto-load `.env` files. Export variables in your shell or process manager.

Never commit:

- `wallet.json`, `wallet.password`, `validator-key.json`, `oracle-key.json`
- `peer-token.txt`, `signer-token.txt`
- live genesis operator secrets, `.env`, `*.pem`, `*.key`

`.gitignore` already excludes those names. See [`L1_SECRET_FILE_POLICY.md`](L1_SECRET_FILE_POLICY.md) and [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## Known limitations

- Permissioned validator set (local launcher uses two validators). This is not Bitcoin-like or permissionless finality.
- 30-second block interval; first finality takes about one to two minutes.
- Each `npm run devnet` creates a new chain. It does not resume an earlier session.
- Interactive runs keep the temporary directory (including development passwords) for diagnosis. Delete it when finished.
- No light-client mobile wallet, hardware-wallet integration, or public explorer.
- Independent-operator, multi-region, HSM-custody, external-audit, and sustained-Internet soak evidence remain open. See [`STANDALONE_L1_READINESS.md`](STANDALONE_L1_READINESS.md).

## Report issues

Use GitHub issues for tester bugs. Follow [`SECURITY.md`](../SECURITY.md) for vulnerabilities. Do not paste private keys, password files, or signer tokens.
