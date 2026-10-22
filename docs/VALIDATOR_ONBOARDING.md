# Validator onboarding for independent operators

> **TESTNET ONLY. Not audited. No rewards.** Test ZYN has no value, cannot be bought or sold, and is not redeemable for mainnet ZYN. There is no mainnet. ZyronChain has **not** had a professional security audit; all reviews so far are self-reviews and AI-assisted reviews. Running a validator earns nothing and nothing in this document promises a reward, an allocation or a future role.

This guide is for people who want to operate a ZyronChain validator on their own machine. It covers key generation, the proof of possession that a value-bearing genesis requires (P1-07, `docs/VALIDATOR_POSSESSION_PROOF.md`), running a node, and how admission to the validator set works. The short volunteer checklist is [`VALIDATOR_VOLUNTEERS.md`](VALIDATOR_VOLUNTEERS.md); this document is the long form.

Every command below was run against `main` at the commit this file was added in, on Linux with Node.js 22, in a scratch directory.

## 1. Honest limits first

- **Hosted testnet validators are not open to outside validators yet.** The 4 validators of the hosted open testnet run on one host and listen on loopback. They expose only a read-only peer surface (`/peer/status`, `/peer/blocks`). An outside validator cannot exchange v6 consensus messages with them today. What you can do today: run a **follower** that verifies the hosted chain (section 5), and register your validator key (section 3) so it can be admitted once a consensus endpoint exists.
- **The hosted testnet genesis does not use `validatorAdmission`.** Possession proofs are required only by value-bearing network classes (`public-launch`, `value-bearing`, `mainnet`). On the current testnet you will not be asked for one; section 4 explains how to make one for a value-bearing genesis ceremony and lets you rehearse it on a scratch chain.
- **Possession proofs are made with the CLI.** The consensus rules are on `main` (#1091 genesis proofs, #1093 `validator_update` proofs). `zyron-l1 validator-possession-proof` signs a proof with your own key, and `zyron-l1 validator-submit --possession-proof` attaches proofs to a `validator_update` (section 4). Putting genesis proofs into the genesis file is still a short local script for the coordinator (section 4.3).
- **Hardware minimums have not been measured.** See section 2 for what was observed, not a guarantee.
- The possession-proof code has had AI review only, not an independent review. Its status is IMPLEMENTED — INDEPENDENT RETEST PENDING.

## 2. Requirements

- Linux or macOS. Node.js 22 or newer, npm, git, curl.
- Durable local storage for the key and the signing journal: not a temporary directory, not a disk restored from snapshots.
- An always-on host if you want to validate. A validator that is down reduces the network's fault margin.
- Observed, not a requirement: a follower that synced about 3,200 testnet blocks used about 7 MB of disk. CPU, RAM and bandwidth minimums for a signing validator have not been measured and will be published when they are.
- Network: a follower needs outbound HTTPS only. Never expose validator RPC or consensus ports directly to the internet; use a reverse proxy or tunnel for anything public.

## 3. Build and generate your validator key

```sh
git clone https://github.com/zyron249/-zyronchain.git
cd -- -zyronchain
git checkout --detach <APPROVED_COMMIT_SHA>   # validators only; followers and rehearsals can stay on main (see below)
cd l1
npm ci && npm run build
npm run testnet:open:smoke      # optional disposable end-to-end check

umask 077
mkdir -p "$HOME/zyron-validator"
# Create the password file yourself: a regular file, mode 0600, 12 characters to 1 KiB.
# (Or use --password-prompt instead of --password-file to type it interactively.)
node dist/src/secure-cli.js keygen --out "$HOME/zyron-validator/validator-key.json" \
  --password-file "$HOME/zyron-validator/validator-key.password"
```

Which commit: for a follower or a rehearsal, the latest `main` is fine. A validator that signs for a network must run the commit approved for that network, announced together with its admission (the same rule as `docs/V6_OPERATOR_GUIDE.md` section 2.1). Record the commit SHA, `node --version` and `sha256sum package-lock.json`. Use `node dist/src/secure-cli.js` (the entrypoint the published `zyron-l1` binary uses, `docs/CLI_RECOVERY_INPUT_SECURITY.md`); do not run `dist/src/cli.js` directly.

`keygen` writes an encrypted keystore (v2, scrypt N=2^17) with mode 0600 and prints the address, the checksummed display address and the public key. Check that the file decrypts and re-derives the same identity:

```sh
ZYRON_KEYSTORE_PASSWORD_FILE="$HOME/zyron-validator/validator-key.password" \
  node dist/src/secure-cli.js keystore-verify --key "$HOME/zyron-validator/validator-key.json"
```

To register, open a GitHub issue titled `Open testnet validator: <your handle>` with **only** your public key and address, whether you can run always-on, and optionally a rough region.

**Never send a private key, key file, password file or signer token to anyone, including maintainers. Nobody from the project will ask for them.**

## 4. Proof of possession

A possession proof is your validator key's signature, under the domain `zyronchain/validator-possession/v1`, over

```
{ chainId, chainBinding, activationHeight, address, publicKey }
```

It shows that you hold the private key and consent to join one specific chain at one specific activation. It cannot be replayed into another chain or a later update.

| Where | `chainBinding` | `activationHeight` | Who assembles it |
|---|---|---|---|
| Genesis validator of a value-bearing genesis | the genesis configuration commitment (computed with the proofs left out, so the chain identity never depends on proof bytes) | `0` | the genesis coordinator, into `validatorAdmission.genesisProofs`, in validator order |
| Validator added later by `validator_update` on a chain with `validatorAdmission` | the chain's genesis hash | the update's activation height | the update initiator, into `possessionProofs`, in the order of the incoming validators |

You only ever sign; you never hand over your key. Sign on the machine that holds the key, and send back only the proof file (`{ "address", "signature" }`).

### 4.1 Signing command

`zyron-l1 validator-possession-proof` decrypts your keystore in memory (password from `ZYRON_KEYSTORE_PASSWORD_FILE`, `ZYRON_KEYSTORE_PASSWORD` or a terminal prompt), checks that your key is one of the listed validators, signs, verifies its own signature, and writes only `{ "address", "signature" }` to `--out`. It refuses to overwrite an existing file. It sends nothing. It prints the exact statement it signed:

```sh
# genesis validator (activation height 0; chain binding computed from the genesis file)
node dist/src/secure-cli.js validator-possession-proof --genesis genesis.json \
  --key "$HOME/zyron-validator/validator-key.json" --out proof.json

# validator added by a validator_update (activation height taken from the proposal)
node dist/src/secure-cli.js validator-possession-proof --proposal update.json --genesis-hash <genesisHash> \
  --key "$HOME/zyron-validator/validator-key.json" --out proof.json
```

Before you send the proof, check `chainId`, `chainBinding` and `activationHeight` in the printed statement against values you obtained independently, for example the published genesis file and its SHA-256, or `GET /status` from more than one source. Do not sign values you only received from the person asking for the proof.

### 4.2 Genesis binding for a value-bearing genesis

The coordinator publishes the draft genesis. Every validator signs from that file with `--genesis` (section 4.1). The command computes the binding itself, using the genesis configuration commitment with `validatorAdmission.genesisProofs` left empty, so any proofs already in the draft do not change it. It signs with `activationHeight` `0`.

The coordinator's precheck (`tokenomics:check` with `--before-possession-proofs`, exact invocation in `docs/PUBLIC_LAUNCH_CHECKLIST.md` and `docs/FIXED_SUPPLY_TOKENOMICS.md`) prints the same value as `Possession proof chain binding (genesis configuration commitment)`. Compare it with the `chainBinding` in your printed statement, and do not send the proof if they differ.

Ceremony order for the coordinator:

1. Run the precheck on the draft with an empty `genesisProofs`.
2. Collect one proof per validator.
3. Place the proofs in `validatorAdmission.genesisProofs`, in validator order, with `"policy": "possession-proof-v1"`.
4. Run the check again without the flag. Only that final run counts.

A node refuses to start on a genesis with a missing, extra, misordered or invalid proof.

### 4.3 Rehearse it on a scratch chain

Run from `l1/` after section 3. Everything lives in a throwaway directory; never reuse these keys.

```sh
R=$(mktemp -d) && umask 077
for i in 1 2 3 4; do
  head -c 24 /dev/urandom | base64 > "$R/pw$i"
  node dist/src/secure-cli.js keygen --out "$R/k$i.json" --password-file "$R/pw$i" | awk '/^Public key:/ {print $3}' > "$R/pub$i"
done
ADDR=$(ZYRON_KEYSTORE_PASSWORD_FILE="$R/pw1" node dist/src/secure-cli.js keystore-verify --key "$R/k1.json" | awk '/^Address:/ {print $2}')
node dist/src/secure-cli.js genesis --out "$R/genesis.json" --chain-id zyron-scratch-1 \
  --validator-public-key "$(cat "$R/pub1")" --validator-public-key "$(cat "$R/pub2")" \
  --validator-public-key "$(cat "$R/pub3")" --validator-public-key "$(cat "$R/pub4")" \
  --oracle-public-key "$(cat "$R/pub1")" --activity-pool "$ADDR" --allocation "$ADDR:1000"
for i in 1 2 3 4; do
  ZYRON_KEYSTORE_PASSWORD_FILE="$R/pw$i" node dist/src/secure-cli.js validator-possession-proof \
    --genesis "$R/genesis.json" --key "$R/k$i.json" --out "$R/proof$i.json"
done
# coordinator: assemble validatorAdmission in validator order and check it
node --input-type=module -e '
import fs from "node:fs"; import { resolve } from "node:path";
const R = process.argv[1];
const va = await import(resolve("dist/src/validator-admission.js"));
const g = JSON.parse(fs.readFileSync(R + "/genesis.json", "utf8"));
const proofs = [1, 2, 3, 4].map((i) => JSON.parse(fs.readFileSync(R + "/proof" + i + ".json", "utf8")));
const byAddress = new Map(proofs.map((p) => [p.address, p]));
g.validatorAdmission = { policy: "possession-proof-v1", genesisProofs: g.validators.map((v) => byAddress.get(v.address)) };
va.assertGenesisPossessionProofs(g);
fs.writeFileSync(R + "/genesis-with-proofs.json", JSON.stringify(g, null, 2));
console.log("genesis possession proofs OK");
' "$R"
mkdir -m 700 "$R/data1"
ZYRON_KEYSTORE_PASSWORD_FILE="$R/pw1" node dist/src/secure-cli.js node --genesis "$R/genesis-with-proofs.json" \
  --data "$R/data1" --validator-key "$R/k1.json" --host 127.0.0.1 --port 19371
# prints "... node listening on http://127.0.0.1:19371" and "Genesis <hash>, height 0"; stop with Ctrl-C
```

With one validator of four running, the chain stays at height 0 (no quorum), so this rehearsal only checks that the node accepts the proofs at start. Then try mutations on `genesis-with-proofs.json`: reverse `genesisProofs`, drop one, or sign a different binding. The node must refuse to start on each one. Reversing the order, for example, fails with `Genesis possession proof does not match the genesis validator order`.

### 4.4 Proof for a later `validator_update`

On a chain with `validatorAdmission`, the binding is the chain's genesis hash (`GET /status` → `genesisHash`) and the height is the update's activation height. The initiator creates the proposal with `validator-proposal` as usual and shares it. Each incoming validator signs from that proposal file:

```sh
ZYRON_KEYSTORE_PASSWORD_FILE="$HOME/zyron-validator/validator-key.password" \
  node dist/src/secure-cli.js validator-possession-proof --proposal update.json \
  --genesis-hash <genesisHash> --key "$HOME/zyron-validator/validator-key.json" --out proof.json
```

The initiator attaches one proof per incoming validator when submitting. Order on the command line does not matter: `validator-submit` sorts the proofs into proposal validator order. Before sending anything, it checks each proof against the chain ID and genesis hash reported by `--rpc` and the proposal's activation height. It refuses a duplicate proof, a proof for an address outside the proposal, or a proof that does not verify:

```sh
node dist/src/secure-cli.js validator-submit --proposal update.json \
  --approval approval-a.json --approval approval-b.json --approval approval-c.json \
  --possession-proof proof-new1.json --possession-proof proof-new2.json \
  --key initiator.json --rpc <url>
```

Proofs are needed only for incoming validators. Validators that continue from the current set need none, and consensus refuses extra proofs. A validator that is removed and re-added needs a fresh proof.

On a chain with `validatorAdmission`, the field is mandatory even when no validator comes in, for example in a removal-only update. Pass `--validator-admission true` and `validator-submit` sends `possessionProofs: []` when no `--possession-proof` is given. On a chain without `validatorAdmission`, consensus refuses the field, so leave out `--possession-proof`. `--validator-admission false` makes the command refuse any proof you pass.

## 5. Run a follower against the hosted testnet

```sh
# run from the l1/ directory of your checkout (section 3)
curl -s https://zyron-open-testnet.onrender.com/genesis | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).genesis,null,2)))' > "$HOME/zyron-open-testnet-genesis.json"
mkdir -m 700 -p "$HOME/zyron-follower"
node dist/src/secure-cli.js node --genesis "$HOME/zyron-open-testnet-genesis.json" --data "$HOME/zyron-follower" \
  --host 127.0.0.1 --port 9137 --peer https://zyron-open-testnet.onrender.com/peer
# in another terminal; height should track https://zyron-open-testnet.onrender.com/status
curl -s -H 'x-zyron-rpc-version: 1' http://127.0.0.1:9137/status
```

The first sync downloads and re-validates every finalized block and certificate before the RPC starts listening (`Synced N finalized block(s) from configured peers`); this can take a minute or more. The follower holds no key and signs nothing. A genesis mismatch can mean the hosted network was reset, but do not trust the endpoint alone for that. Before you fetch a new genesis and start a new data directory, confirm the new genesis hash through an independent channel: the pinned `EXPECTED_GENESIS` in `.github/workflows/open-testnet-snapshot-keeper.yml` on `main` and `docs/OPEN_TESTNET.md`, and the reset announcement. If they disagree, keep your old data directory and report it.

A signing key alone does not make this command a validator. The follower talks only to the hosted read-only HTTP peer on loopback, which carries no v6 prepare/commit traffic. An admitted validator also needs a native P2P listener (`--p2p-listen`), pinned bootstrap peers (`--p2p-peer`, `--p2p-peer-group`), every other validator as `--p2p-consensus-peer`, and its key (`--validator-key <key.json>` with the password in `ZYRON_KEYSTORE_PASSWORD_FILE`, or a remote signer, `--validator-signer-url`). See `docs/L1_OPERATIONS_RUNBOOK.md` and `docs/V6_OPERATOR_GUIDE.md`. The exact network-specific startup command (peer IDs, addresses, approved commit) is given to each operator at admission; none exists for the hosted testnet yet.

### 5.1 Upgrading after a genesis relaunch

The genesis currently pinned for `zyron-open-testnet-render-1` is `e0212e574271ef1de78ad148965e3d1a4a04afca3071d3c374d29ae5a6d4a8ad` (genesis timestamp 2026-10-20T22:09:28.767Z). That genesis carries fields that older code does not know: `activityOracleThreshold` and `activityOraclePolicy` (added in #1076, `f3913f2`) and `publicDistributionRelease` (added in #1075, `69171bf`). Genesis loading rejects unknown fields, so a node built before those changes stops at start with:

```text
Fatal: Invalid genesis fields
```

Any `main` at or after `fdd1e792` contains both changes. (`fdd1e792` itself, #1092, only changes the stranded-pruning test fixtures of `l1/scripts/open-testnet.mjs`; it is used here as a known-good reference point, not as the commit that added the fields.)

1. **Confirm the expected hash independently.** Compare the `EXPECTED_GENESIS` pin in `.github/workflows/open-testnet-snapshot-keeper.yml` on `main`, `docs/OPEN_TESTNET.md`, and the reset announcement. If they disagree, stop, keep your data directory and report it.
2. **Update the code** to the latest `main` and check that `fdd1e792` is included:
   ```sh
   git fetch origin && git checkout main && git pull --ff-only origin main
   git merge-base --is-ancestor fdd1e792 HEAD && echo "includes fdd1e792"
   ```
3. **Rebuild** (section 3):
   ```sh
   cd l1 && npm ci && npm run build
   ```
4. **Verify the genesis hash** the network reports. `GET /status` and `GET /genesis` return it; check it against the pin from step 1:
   ```sh
   curl -s https://zyron-open-testnet.onrender.com/status
   ```
   A node prints `Genesis <hash>, height <n>` when it starts; that hash must equal the pin too.
5. **Archive the old data directory, do not delete it.** Stop the node, then move the directory aside, for example `mv "$DIR" "$DIR.pre-e0212e57-$(date +%Y%m%d)"`. Keep it until the new chain is confirmed; it is the evidence if anything turns out wrong.
6. **Restart** with a fresh, empty data directory against the new genesis (commands below), and check that the start-up line shows the pinned hash.

For the follower in section 5, the data directory is the `--data` path (`$HOME/zyron-follower` in the example):

```sh
mv "$HOME/zyron-follower" "$HOME/zyron-follower.pre-e0212e57-$(date +%Y%m%d)"
```

Then re-run the section 5 commands: fetch the genesis again, create the empty directory with `mkdir -m 700 -p`, and start the node.

## 6. How admission works

**Open testnet (today).** Validators change only through on-chain governance: an existing validator creates a proposal (`validator-proposal --activation-height <n> --validator-public-key <hex> ...`), at least `floor(2n/3)+1` current validators approve it (`validator-approve`), and it is submitted (`validator-submit`). Activation must be at least 100 blocks ahead. A fixed-supply chain keeps between 4 and 100 validators. Because the hosted validators have no outside consensus endpoint yet, no outside key will be voted in until that exists; adding a validator that cannot reach the others would only weaken the quorum.

**Value-bearing genesis (future).** The genesis must carry `validatorAdmission` with one possession proof per initial validator (section 4.2). Later additions need the same quorum approval plus a possession proof from each incoming validator (section 4.4). No value-bearing genesis exists; creating one is an owner decision and is not scheduled.

## 7. Operating rules

- **Never run two copies of one validator key**, and never restore a signing validator's data directory from an old backup or a VM/disk snapshot. Both can make an honest validator sign conflicting votes.
- Keep the key, password file and data directory mode 0600/0700 on durable local storage, outside any repository.
- If your node will be down, say so in your registration issue.
- Report bugs as GitHub issues. Report vulnerabilities privately through <https://github.com/zyron249/-zyronchain/security/advisories/new> (see `SECURITY.md` and `BUG_BOUNTY.md`).
