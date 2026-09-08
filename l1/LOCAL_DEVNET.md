# Run the local two-validator network

Use Node.js 22 or 24 on Linux or macOS. Validators need POSIX directory fsync
for crash-durable storage and anti-double-sign journals. Native Windows cannot
provide that contract through this implementation; do not disable the checks.

```sh
git clone https://github.com/zyron249/-zyronchain.git
cd -- -zyronchain/l1
npm ci
npm run devnet
```

The command builds the node, creates a fresh private development chain, generates
three random encrypted development keystores, and starts two independent
validator processes. Both RPC listeners bind only to `127.0.0.1`; their free
ports and temporary data directory are printed. There is no public listener,
NAT mapping, firewall change, external peer, or deployment credential.

The validators must finalize a block and confirm the same signed 1 ZYN transfer
before the command reports readiness. The normal block interval is 30 seconds,
so allow about one to two minutes. After readiness the validators keep running.
Use the printed URLs to inspect `/status`, `/healthz`, `/readyz`, and
`/balance/<address>`. Ctrl+C stops both processes cleanly. Each invocation starts
a new chain; this launcher does not resume earlier sessions.

The printed temporary directory is private to the current OS user (0700).
Keystores and generated password files are 0600 and are retained there after an
interactive run or failed check for diagnosis. These passwords live alongside
the development keys for unattended local startup: this is not an operator
key-management design. Do not fund these addresses, copy secrets into Git, or
use these disposable keys for a public network. Remove the printed directory
when no longer needed.

## Windows

Use an existing WSL2 Ubuntu terminal. If WSL is not installed, install it using
Microsoft's WSL installation procedure first; that system operation may need
administrator access and a restart. Inside Ubuntu, install Node.js 22 or 24,
then run the commands above from your Linux home directory (`cd ~`). Do not
place validator state under `/mnt/c` or another Windows-mounted filesystem.

You can also run verification entirely on GitHub without installing WSL:
open **Actions → Standalone L1 CI → Run workflow**, choose the branch, and run
the workflow. The **local-devnet** job uses Ubuntu and the same command below.
This checks a disposable network; a GitHub Actions job is not a persistent node
hosting service.

## Automated end-to-end check

```sh
npm run devnet:check
```

The check requires actual CLI processes, encrypted key loading, real local HTTP
RPC, both validator signatures, identical finalized tips and balances, correct
sender nonce/fee accounting, no finality without the second validator, resumed
finality after that validator returns, and replay of the same tip and balance
after both nodes restart. It does not mock consensus or shorten the protocol's
block interval. Allow several minutes. A successful check prints JSON with
`ok: true`, stops both validators, and deletes only its own temporary directory.
Failures exit nonzero and retain bounded node logs in that directory.

Run the broader checks independently:

```sh
npm run typecheck
npm test
```

Local verification does not activate public mining, public testnet, or mainnet.
