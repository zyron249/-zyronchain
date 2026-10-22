# Volunteer testnet validators

> Source of truth: [`OPEN_TESTNET.md`](OPEN_TESTNET.md). Long-form guide with key generation, proof of possession and admission: [`VALIDATOR_ONBOARDING.md`](VALIDATOR_ONBOARDING.md).

**TESTNET: tokens have no value.** Test ZYN cannot be bought or sold and is not redeemable for mainnet ZYN. The network may be reset at any time. ZyronChain has **not** had a professional security audit.

## Why we need you

The open testnet runs the canonical TypeScript L1 with protocol v6 (locked two-phase BFT), 4 validators and a quorum of 3, so one validator can stop without halting finality. **All 4 validators are run by the project on one host in one region.** That means it is not yet an independent-operator network. Volunteers who run validators on their own machines are how that changes.

Running a testnet validator earns nothing. Test ZYN has no value, and validators get no reward.

## Current status

The hosted network at https://zyron-open-testnet.onrender.com runs on a free plan without a disk. Its state persists through sealed snapshots that are restored on every cold start (see `docs/OPEN_TESTNET.md`). Check `GET /status` for `chainId`, `genesisHash`, `height` and `persistence`. A genesis-hash change means a reset, and it is announced if it ever happens.

- **Available now:** run a follower node that syncs and verifies the hosted chain (step 4a).
- **Not yet:** validator activation. The hosted validators listen on loopback and expose only a read-only peer surface (`/peer/status`, `/peer/blocks`). A volunteer validator cannot exchange v6 consensus messages with them yet. Register your key now (step 3) so that you can be added when a consensus endpoint exists.

## Requirements

- Linux or macOS.
- Node.js 22 or newer, npm, git.
- Durable local storage for the key and signing journal. Not a temporary directory, and not a disk that is restored from snapshots.
- For an always-on validator: a host that stays up. Minimum CPU, RAM, disk and bandwidth have not been measured yet and will be published once they are.

## Steps

### 1. Build and check your environment

```sh
git clone https://github.com/zyron249/-zyronchain.git
cd -- -zyronchain/l1
npm ci && npm run build
npm run testnet:open:smoke   # disposable end-to-end check (the same check runs in CI)
```

### 2. (Optional) Run your own copy of the open testnet

```sh
node scripts/open-testnet.mjs init --dir "$HOME/zyron-open-testnet"   # fresh TEST keys, mode 0600
node scripts/open-testnet.mjs run  --dir "$HOME/zyron-open-testnet" --port 10000
```

This directory holds plaintext **test** validator and faucet keys. Keep it outside the repository and never reuse those keys anywhere else. If you expose the gateway, put it behind a reverse proxy or tunnel. Never expose validator ports.

### 3. Generate a validator key and register it

```sh
umask 077
mkdir -p "$HOME/zyron-validator"
# create a password file first: regular file, mode 0600, 12 characters to 1 KiB
node dist/src/cli.js keygen --out "$HOME/zyron-validator/validator-key.json" \
  --password-file "$HOME/zyron-validator/validator-key.password"
```

Open a GitHub issue titled `Open testnet validator: <your handle>`. Include **only**:

- your validator **public key** and **address**;
- whether you can run always-on, and your rough region if you want to share it (optional; this helps with geographic spread).

**Never send a private key, a key file, a password file or a signer token to anyone, including project maintainers.** Nobody from the project will ever ask for them.

### 4a. Run a follower node against the hosted testnet

```sh
cd -- -zyronchain/l1
curl -s https://zyron-open-testnet.onrender.com/genesis | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).genesis,null,2)))' > "$HOME/zyron-open-testnet-genesis.json"
mkdir -m 700 -p "$HOME/zyron-follower"
node dist/src/cli.js node --genesis "$HOME/zyron-open-testnet-genesis.json" --data "$HOME/zyron-follower" \
  --host 127.0.0.1 --port 9137 --peer https://zyron-open-testnet.onrender.com/peer
curl -s -H 'x-zyron-rpc-version: 1' http://127.0.0.1:9137/status   # height should track the public /status
```

Your node re-validates every block and certificate itself. It holds no keys and signs nothing. If the node reports a genesis mismatch, the hosted network was reset: download the genesis again and use a new data directory.

### 4. Activation (once the hosted validators have a consensus endpoint)

1. The existing validators add your key through the on-chain validator-update governance flow (`validator-proposal`, `validator-approve`, `validator-submit`). Activation is set at least the minimum update delay ahead.
2. Your node syncs from the peer endpoint and starts signing at the activation height. This needs two-way consensus connectivity, which is not available yet.

### 5. Operating rules

- Keep your key and signing journal on durable local storage.
- **Never run two copies of one validator key**, and never restore a validator's data directory from an old backup or VM/disk snapshot while it is signing. Both can make an honest validator sign conflicting votes.
- If your node stops, say so in your issue so that the others know the quorum margin is smaller.
- Report bugs as GitHub issues. Report vulnerabilities privately through https://github.com/zyron249/-zyronchain/security/advisories/new (see `SECURITY.md` and `BUG_BOUNTY.md`).

## What this testnet does not prove

- There are no independent operators yet. Everything runs on a single host in a single region.
- AI reviews and community testing are not a professional audit.
- This profile does not enable a mainnet, a value-bearing token or trading.
