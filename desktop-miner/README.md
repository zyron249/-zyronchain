# Zyron Miner desktop control panel (development UI)

This directory provides a local, dependency-free control panel around the existing canonical Layer-1 miner launcher. It is intentionally **not** a public miner release and it does not bypass activation, signing, release, or Windows packaging gates.

## What it does

- binds only to `127.0.0.1` on a random local port;
- opens a browser-based desktop-style dashboard automatically;
- starts and stops `l1/scripts/miner-launcher.mjs` as a child process;
- preserves the launcher's encrypted local custody and canonical network-profile checks;
- shows mining wallet address, connectivity, hashrate, current mining height, difficulty, submitted/rejected claims, finalized network height and confirmed wallet balance;
- polls only public/read-only RPC status and balance endpoints;
- never reads, returns, logs, or serves `wallet.json` or `wallet.password`;
- refuses Start Mining while `l1/miner-network-profile.json` has `publicMiningActivated=false`.

## Current boundary

The checked-in canonical miner profile remains activation-gated. Therefore the Start Mining button is disabled on `main` until a separately reviewed activation changes that canonical profile. This UI must not be used as evidence that public mining, public testnet, or mainnet is live.

Windows self-contained miner packaging remains governed by the existing Windows miner distribution quarantine and release-candidate controls. This control panel does not build an `.exe`, ZIP, installer, release asset, or website download.

## Run on Windows during development

Prerequisites:

1. Windows Node.js 22 or 24 is installed and available as `node.exe`.
2. The Layer-1 dependencies and build already exist:

```text
cd l1
npm ci
npm run build
```

Then double-click:

```text
desktop-miner\start-windows.cmd
```

The command window stays open while the local control panel is running. Closing it stops the local UI; use **STOP MINING** before closing when the miner is running.

## Run on Linux / WSL / macOS

```sh
cd l1
npm ci
npm run build
cd ../desktop-miner
./start-posix.sh
```

## Security notes

The local HTTP controller accepts loopback connections only. Mutating requests require an unpredictable per-process control token and same-origin checks. The page has a restrictive Content Security Policy and no CORS opt-in. The miner itself remains responsible for encrypted keystore validation, local custody, genesis/network identity, HTTPS requirements, mining work and transaction signing.
