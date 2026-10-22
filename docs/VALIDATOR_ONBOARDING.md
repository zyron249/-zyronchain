# Validator onboarding for independent operators

> **TESTNET ONLY. Not audited. No rewards.** Test ZYN has no value, cannot be bought or sold, and is not redeemable for mainnet ZYN. There is no mainnet. ZyronChain has **not** had a professional security audit; all reviews so far are self-reviews and AI-assisted reviews. Running a validator earns nothing and nothing in this document promises a reward, an allocation or a future role.

This guide is for people who want to operate a ZyronChain validator on their own machine. It covers key generation, the proof of possession that a value-bearing genesis requires (P1-07, `docs/VALIDATOR_POSSESSION_PROOF.md`), running a node, and how admission to the validator set works. The short volunteer checklist is [`VALIDATOR_VOLUNTEERS.md`](VALIDATOR_VOLUNTEERS.md); this document is the long form.

Every command below was run against `main` at the commit this file was added in, on Linux with Node.js 22, in a scratch directory.

## 1. Honest limits first

- **Hosted testnet validators are not open to outside validators yet.** The 4 validators of the hosted open testnet run on one host and listen on loopback. They expose only a read-only peer surface (`/peer/status`, `/peer/blocks`). An outside validator cannot exchange v6 consensus messages with them today. What you can do today: run a **follower** that verifies the hosted chain (section 5), and register your validator key (section 3) so it can be admitted once a consensus endpoint exists.
- **The hosted testnet genesis does not use `validatorAdmission`.** Possession proofs are required only by value-bearing network classes (`public-launch`, `value-bearing`, `mainnet`). On the current testnet you will not be asked for one; section 4 explains how to make one for a value-bearing genesis ceremony and lets you rehearse it on a scratch chain.
- **No CLI command makes a possession proof yet.** The consensus rules are on `main` (#1091 genesis proofs, #1093 `validator_update` proofs), but the `zyron-l1` CLI cannot yet create a proof or attach `possessionProofs` to a `validator_update`. That is a tracked follow-up. Section 4 gives a short local script that uses the built library functions instead.
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
cd -- -zyronchain/l1
npm ci && npm run build
npm run testnet:open:smoke      # optional disposable end-to-end check

umask 077
mkdir -p "$HOME/zyron-validator"
# Create the password file yourself: a regular file, mode 0600, 12 characters to 1 KiB.
# (Or use --password-prompt instead of --password-file to type it interactively.)
node dist/src/cli.js keygen --out "$HOME/zyron-validator/validator-key.json" \
  --password-file "$HOME/zyron-validator/validator-key.password"
```

`keygen` writes an encrypted keystore (v2, scrypt N=2^17) with mode 0600 and prints the address, the checksummed display address and the public key. Check that the file decrypts and re-derives the same identity:

```sh
ZYRON_KEYSTORE_PASSWORD_FILE="$HOME/zyron-validator/validator-key.password" \
  node dist/src/cli.js keystore-verify --key "$HOME/zyron-validator/validator-key.json"
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

You only ever sign; you never hand over your key. Sign on the machine that holds the key, and send back only the `proof` object (address + signature).

### 4.1 Signing script (local, until the CLI supports it)

Save this outside the repository as `sign-possession-proof.mjs`. It decrypts your keystore in memory, signs, verifies its own signature and prints the statement and proof. It writes nothing and sends nothing.

```js
// node sign-possession-proof.mjs <l1-dir> <key.json> <password-file> <chainId> <chainBinding> <activationHeight>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [l1, keyFile, pwFile, chainId, chainBinding, h] = process.argv.slice(2);
const ks = await import(resolve(l1, "dist/src/keystore.js"));
const va = await import(resolve(l1, "dist/src/validator-admission.js"));
const cr = await import(resolve(l1, "dist/src/crypto.js"));
const priv = ks.decryptPrivateKey(JSON.parse(readFileSync(keyFile, "utf8")), ks.normalizePasswordFile(readFileSync(pwFile, "utf8")));
const publicKey = cr.publicKeyFromPrivate(priv);
const address = cr.addressFromPublicKey(publicKey);
const statement = { chainId, chainBinding, activationHeight: Number(h), address, publicKey };
const signature = va.signPossessionProof(statement, priv);
if (!va.verifyPossessionProof(statement, signature)) throw new Error("self-check failed");
console.log(JSON.stringify({ statement, proof: { address, signature } }, null, 2));
```

Before signing, check `chainId`, `chainBinding` and `activationHeight` against values you obtained independently (for example the published genesis file and its SHA-256, or `GET /status` from more than one source). Do not sign values you only received from the person asking for the proof.

### 4.2 Genesis binding for a value-bearing genesis

The coordinator publishes the draft genesis. Every validator computes the binding themselves from that file:

```js
// node genesis-binding.mjs <l1-dir> <genesis.json>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const [l1, file] = process.argv.slice(2);
const va = await import(resolve(l1, "dist/src/validator-admission.js"));
const g = JSON.parse(readFileSync(file, "utf8"));
const unsigned = { ...g, validatorAdmission: { policy: va.POSSESSION_PROOF_POLICY_V1, genesisProofs: [] } };
console.log(va.genesisPossessionChainBinding(unsigned));
```

Then sign with `activationHeight` `0`:

```sh
B=$(node genesis-binding.mjs . genesis.json)
node sign-possession-proof.mjs . "$HOME/zyron-validator/validator-key.json" \
  "$HOME/zyron-validator/validator-key.password" <chainId> "$B" 0
```

The coordinator's precheck (`tokenomics:check` with `--before-possession-proofs`, exact invocation in `docs/PUBLIC_LAUNCH_CHECKLIST.md` and `docs/FIXED_SUPPLY_TOKENOMICS.md`) prints the same value as `Possession proof chain binding (genesis configuration commitment)`; compare it with your own result and do not sign if they differ.

Ceremony order for the coordinator: run the precheck on the draft with an empty `genesisProofs`, collect one proof per validator, place them in `validatorAdmission.genesisProofs` in validator order with `"policy": "possession-proof-v1"`, then run the check again without the flag; only that final run counts. A node refuses to start on a genesis with a missing, extra, misordered or invalid proof.

### 4.3 Rehearse it on a scratch chain

Run from `l1/` after section 3, with `sign-possession-proof.mjs` and `genesis-binding.mjs` saved in `$R`. Everything lives in a throwaway directory; never reuse these keys.

```sh
R=$(mktemp -d) && umask 077
# save sign-possession-proof.mjs (4.1) and genesis-binding.mjs (4.2) into "$R" first
for i in 1 2 3 4; do
  head -c 24 /dev/urandom | base64 > "$R/pw$i"
  node dist/src/cli.js keygen --out "$R/k$i.json" --password-file "$R/pw$i" | awk '/^Public key:/ {print $3}' > "$R/pub$i"
done
ADDR=$(ZYRON_KEYSTORE_PASSWORD_FILE="$R/pw1" node dist/src/cli.js keystore-verify --key "$R/k1.json" | awk '/^Address:/ {print $2}')
node dist/src/cli.js genesis --out "$R/genesis.json" --chain-id zyron-scratch-1 \
  --validator-public-key "$(cat "$R/pub1")" --validator-public-key "$(cat "$R/pub2")" \
  --validator-public-key "$(cat "$R/pub3")" --validator-public-key "$(cat "$R/pub4")" \
  --oracle-public-key "$(cat "$R/pub1")" --activity-pool "$ADDR" --allocation "$ADDR:1000"
B=$(node "$R/genesis-binding.mjs" . "$R/genesis.json")
for i in 1 2 3 4; do
  node "$R/sign-possession-proof.mjs" . "$R/k$i.json" "$R/pw$i" zyron-scratch-1 "$B" 0 > "$R/proof$i.json"
done
# assemble validatorAdmission in validator order and check it
node --input-type=module -e '
import fs from "node:fs"; import { resolve } from "node:path";
const R = process.argv[1];
const va = await import(resolve("dist/src/validator-admission.js"));
const g = JSON.parse(fs.readFileSync(R + "/genesis.json", "utf8"));
const proofs = [1, 2, 3, 4].map((i) => JSON.parse(fs.readFileSync(R + "/proof" + i + ".json", "utf8")).proof);
const byAddress = new Map(proofs.map((p) => [p.address, p]));
g.validatorAdmission = { policy: "possession-proof-v1", genesisProofs: g.validators.map((v) => byAddress.get(v.address)) };
va.assertGenesisPossessionProofs(g);
fs.writeFileSync(R + "/genesis-with-proofs.json", JSON.stringify(g, null, 2));
console.log("genesis possession proofs OK");
' "$R"
mkdir -m 700 "$R/data1"
ZYRON_KEYSTORE_PASSWORD_FILE="$R/pw1" node dist/src/cli.js node --genesis "$R/genesis-with-proofs.json" \
  --data "$R/data1" --validator-key "$R/k1.json" --host 127.0.0.1 --port 19371
# prints "... node listening on http://127.0.0.1:19371" and "Genesis <hash>, height 0"; stop with Ctrl-C
```

With one validator of four running, the chain stays at height 0 (no quorum); this rehearsal only checks that the proofs are accepted at start. Try mutations on `genesis-with-proofs.json` (reverse `genesisProofs`, drop one, sign a different binding): node start must refuse each one. Reversing the order, for example, fails with `Genesis possession proof does not match the genesis validator order`.

### 4.4 Proof for a later `validator_update`

On a chain with `validatorAdmission`, the binding is the genesis hash and the height is the update's activation height:

```sh
node sign-possession-proof.mjs . "$HOME/zyron-validator/validator-key.json" \
  "$HOME/zyron-validator/validator-key.password" <chainId> <genesisHash> <activationHeight>
```

The initiator must put the proof in the transaction's `possessionProofs`. The current `validator-proposal` / `validator-submit` CLI does not do that yet (section 1), so on such a chain admission waits for that follow-up.

## 5. Run a follower against the hosted testnet

```sh
cd -- -zyronchain/l1
curl -s https://zyron-open-testnet.onrender.com/genesis | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s).genesis,null,2)))' > "$HOME/zyron-open-testnet-genesis.json"
mkdir -m 700 -p "$HOME/zyron-follower"
node dist/src/cli.js node --genesis "$HOME/zyron-open-testnet-genesis.json" --data "$HOME/zyron-follower" \
  --host 127.0.0.1 --port 9137 --peer https://zyron-open-testnet.onrender.com/peer
# in another terminal; height should track https://zyron-open-testnet.onrender.com/status
curl -s -H 'x-zyron-rpc-version: 1' http://127.0.0.1:9137/status
```

The first sync downloads and re-validates every finalized block and certificate before the RPC starts listening (`Synced N finalized block(s) from configured peers`); this can take a minute or more. The follower holds no key and signs nothing. A genesis mismatch means the hosted network was reset: fetch the genesis again and use a new data directory.

To run as a validator on a network you are admitted to, add `--validator-key <key.json>` with the password in `ZYRON_KEYSTORE_PASSWORD_FILE`, or use a remote signer (`--validator-signer-url`, see `docs/V6_OPERATOR_GUIDE.md`).

## 6. How admission works

**Open testnet (today).** Validators change only through on-chain governance: an existing validator creates a proposal (`validator-proposal --activation-height <n> --validator-public-key <hex> ...`), at least `floor(2n/3)+1` current validators approve it (`validator-approve`), and it is submitted (`validator-submit`). Activation must be at least 100 blocks ahead. A fixed-supply chain keeps between 4 and 100 validators. Because the hosted validators have no outside consensus endpoint yet, no outside key will be voted in until that exists; adding a validator that cannot reach the others would only weaken the quorum.

**Value-bearing genesis (future).** The genesis must carry `validatorAdmission` with one possession proof per initial validator (section 4.2). Later additions need the same quorum approval plus a possession proof from each incoming validator (section 4.4). No value-bearing genesis exists; creating one is an owner decision and is not scheduled.

## 7. Operating rules

- **Never run two copies of one validator key**, and never restore a signing validator's data directory from an old backup or a VM/disk snapshot. Both can make an honest validator sign conflicting votes.
- Keep the key, password file and data directory mode 0600/0700 on durable local storage, outside any repository.
- If your node will be down, say so in your registration issue.
- Report bugs as GitHub issues. Report vulnerabilities privately through <https://github.com/zyron249/-zyronchain/security/advisories/new> (see `SECURITY.md` and `BUG_BOUNTY.md`).
