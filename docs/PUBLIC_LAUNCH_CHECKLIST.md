# ZyronChain public-launch checklist

Status: **operator readiness pack**. This is not a securities offering, token sale, or IPO document. "Halka arz" / public launch in this repository means **public network, public mining, and public tester surfaces** — not inventing a hosted RPC, explorer, faucet, chain ID, or flipping activation flags.

Machine-readable authority: [`l1-launch-authorization.json`](l1-launch-authorization.json).  
Human policy: [`L1_LAUNCH_AUTHORIZATION.md`](L1_LAUNCH_AUTHORIZATION.md).  
A–Z engineering gate: [`STANDALONE_L1_READINESS.md`](STANDALONE_L1_READINESS.md).  
Local tester path: [`PUBLIC_TEST.md`](PUBLIC_TEST.md).  
Mining: **retired** by owner decision (2026-09-30). The former local path `cd l1 && npm run mine:local` now exits with an error; [`../l1/MINING.md`](../l1/MINING.md) is a retired record.

`publicTestnetActivationAllowed` and `mainnetActivationAllowed` remain **false**. This checklist does not close those flags.

## How to read this document

| Marker | Meaning |
|---|---|
| Ready | Implemented, tested, and safe to use on loopback / private rehearsal only |
| Prepared | Code and docs exist; external humans/infrastructure/evidence are still missing |
| Blocked | Must stay false or unpublished until independently reviewed evidence exists |

Authorization (`*Authorized=true`) is not activation. Green CI is not activation. Mining code in the binary is not public mining.

## 1. What an operator can do today

| Surface | Status | How | What it is not |
|---|---|---|---|
| Local two-validator public-test | Ready | `cd l1 && npm ci && npm run devnet` | Not a hosted testnet. Fresh `zyron-local-<hex>` every run. RPC on `127.0.0.1` only |
| Automated local check | Ready (known-flaky) | `npm run devnet:check` | The `local-devnet` CI job has timed out on some hosts after quorum-loss recovery |
| Local protocol-v5 mining rehearsal | Retired | `cd l1 && npm run mine:local` exits non-zero | Mining is shut down for every genesis |
| Packaged miner | Retired | `npm run mine` exits non-zero before reading keys | Consensus rejects every `mining_claim` |
| In-process mining regression | Ready (rejection tests) | `cd l1 && npm test` (includes `test/mining*.ts`) | Now asserts mining claims are rejected on every consensus path |
| Website / wallet / validator pages | Ready (docs only) | `python3 -m http.server 8080 --directory website` | No browser custody, no download CTA, no public RPC |
| Legacy Python/Flask node | Legacy only | [`LEGACY_PYTHON_TESTNET.md`](LEGACY_PYTHON_TESTNET.md) | Not the canonical chain. Binds `0.0.0.0` in `app.py` for that archived stack |
| Public L1 RPC / explorer / faucet / bootstrap | Blocked | — | Do not invent hosts or chain IDs |
| Public mining / one-click miner download | Blocked | website `publicMiningActivated: false` | Release-candidate workflows stay `publicationAllowed=false` |
| Public testnet activation | Blocked | `publicTestnetActivationAllowed=false` | See section 3 |
| Mainnet activation | Blocked | `mainnetActivationAllowed=false` | See section 4 |

## 2. Mining is retired

Owner decision (2026-09-30): mining is shut down for every genesis. Consensus rejects `mining_claim` transactions on every path (shape validation, mempool admission, block production, block validation, and both the legacy and State-v2 state appliers), independent of protocol version. Protocol v5 no longer enables issuance.

- `npm run mine:local` (`local-devnet.mjs --local-v5`) exits non-zero; `--check` stays on the protocol-v1 transfer/quorum/restart path.
- `npm run mine` exits non-zero before reading keys, passwords, or contacting any RPC.
- `l1/miner-network-profile.json` keeps `publicMiningActivated=false`.
- The miner packaging/release tooling and workflows still exist in the repository; removing them is a separate, pending owner decision. Nothing may be published from them.

## 3. Public-testnet activation gates

Tracked in `docs/l1-launch-authorization.json` and expanded in `STANDALONE_L1_READINESS.md`. All remain **Blocked**.

| # | Requirement ID | Status | Why it is still open |
|---|---|---|---|
| 1 | `independent-operators-deploy-from-release-artifacts-without-founder-assistance` | Prepared / Blocked | Challenge format and synthetic vectors exist (`independenceProven=false` by design). No reviewed external operator evidence |
| 2 | `bootstrap-archive-monitoring-across-independent-failure-domains` | Blocked | No published public bootstrap/archive set. Labels are not failure domains |
| 3 | `independent-consensus-cryptography-network-audit-and-retest` | Prepared / Blocked | Project audit pack exists. Independent review and remediations are not closed |
| 4 | `independent-protocol-v5-mining-issuance-audit-and-retest` | Blocked | Protocol-v5 mining adds issuance/consensus scope. No independent mining audit/retest |
| 5 | `sustained-independent-operator-internet-adversarial-soak` | Blocked | Render Free is smoke-only (issue #249). Synthetic soak verifier keeps real evidence false |
| 6 | `production-hsm-or-audited-signer-custody-and-cross-host-rotation` | Prepared / Blocked | Remote-signer boundary exists. Production HSM/audited custody is external |
| 7 | `protected-branch-independent-review-repository-policy` | Blocked | Repository *settings* (protected branch / required review) cannot be proven by docs alone |
| 8 | `target-hardware-state-v2-scale-and-recovery-measurements` | Prepared / Blocked | CI 100k-account regression is not release-hardware evidence |
| 9 | `independent-maintainer-and-security-custody-succession-evidence` | Prepared / Blocked | Policy requires ≥2 independent custodians. Placeholder names do not satisfy it |
| 10 | `mining-contention-calibration-and-inclusion-fairness-evidence` | Blocked | Need heterogeneous miners, stale-tip races, inclusion/censorship, RPC abuse, and a reviewed 20-bit vs retarget decision |

Until every row is independently closed, `publicTestnetActivationAllowed` must remain `false`. Related issues: #260 (public-testnet evidence), #249 (Render Free uptime), #390 / #892 (miner publication).

## 4. Mainnet / value-bearing launch gates

Every public-testnet gate plus:

| Requirement ID | Status |
|---|---|
| `immutable-mainnet-chain-id` | Blocked — do not invent |
| `immutable-mainnet-genesis-allocation` | Blocked — zero-premine or explicit disclosure, not improvised |
| `immutable-mining-reward-halving-cap-and-difficulty-policy` | Prepared in code (6.25 ZYN / 4e6 claims / 50M cap / 20-bit); not frozen as a mainnet policy |
| `validator-reward-inflation-and-fee-policy` | Blocked — no validator inflation is invented; fee burns stay burns |
| `activity-oracle-production-governance` | Blocked — keep unfunded/disabled until independent oracles exist |
| `validator-admission-removal-governance` | Prepared as on-chain delayed quorum; public admission process not published |
| `sustained-public-testnet-mining-finality-and-independent-retest` | Blocked — requires a real public testnet first |
| `multi-region-disaster-recovery-and-incident-drills` | Prepared as CI rehearsals; real multi-region drills remain |
| `independent-maintainer-and-security-custody-succession-evidence` | Blocked — same humans/credentials problem |
| `protected-release-tag-and-branch-review-policy` | Blocked — platform settings + independently reproducible artifacts |

Related issue: #261.

## 5. Security review snapshot (defensive)

This pass did **not** write exploits, PoCs, or attack procedures. Findings are for operators and maintainers.

| Severity | Finding | Disposition |
|---|---|---|
| High (gate) | Public testnet/mainnet/mining activation evidence is absent | Keep all activation and publication flags false |
| High (gate) | No independent cryptography/consensus/network/**mining** audit/retest | Stop-ship for public mining |
| Medium | Machine-readable authorization previously omitted mining, capacity, and succession gates that `STANDALONE_L1_READINESS.md` already required | Aligned in `l1-launch-authorization.json` without flipping activation flags |
| Medium | Miners following website/`MINING.md` `127.0.0.1:9137` against default `npm run devnet` would hash forever on protocol v1 or hit the wrong port | Superseded: mining retired (2026-09-30); `mine` and `mine:local` fail closed |
| Low | Packaged miner and CLI treat DNS name `localhost` as loopback for plaintext HTTP | Residual DNS-rebinding class; prefer literal `127.0.0.1` / `::1`. Shared helper tests pin `localhost`; left unchanged this pass |
| Low | Interactive local-devnet retains encrypted keystores **and** password files in one `0700` directory | Documented development-only; do not reuse on any public network |
| Low | `npm run devnet:check` / `local-devnet` CI job is known-flaky on view-change recovery | Documented in `PUBLIC_TEST.md`; not hidden |
| Low | State-v2 cache identity test used a same-length rewrite (`before`/`after!`) that can keep size+mtime+ctime identical on coarse-timestamp filesystems | Test now mutates to a different size so the fail-closed check is deterministic |
| Info | RPC default bind is `127.0.0.1`. Non-loopback listen fail-closes without consensus auth **and** `--rpc-trusted-proxy` | Keep |
| Info | Miner profile `l1/miner-network-profile.json` has `publicMiningActivated=false` and null RPC/genesis | Keep |
| Info | Website miner download CTA stays disabled (`enabled: false`) | Keep |
| Info | Legacy Flask `app.py` listens on `0.0.0.0` | Legacy compatibility only; not a canonical L1 RPC |
| Info | `.gitignore` covers `.env`, keystores, password files, `*.pem` / `*.key`, signer tokens | Keep; never commit secrets |

Recommended next gates (in order, all external):

1. Protected-branch / required-review repository settings (cannot be done from a documentation PR).
2. Independent mining+consensus audit and remediations.
3. Always-on multi-operator soak replacing Render Free (#249).
4. Independent-operator challenge against a candidate network (not synthetic vectors).
5. Heterogeneous local/public-test mining calibration before any 20-bit freeze.
6. Only then consider `publicTestnetActivationAllowed` — still never by autonomous invention of chain ID/RPC.

## 6. What this repository must not do

- Flip `publicTestnetActivationAllowed` or `mainnetActivationAllowed`.
- Do not invent public RPC, explorer, faucet, bootstrap, or chain IDs.
- Publish miner downloads or set `publicMiningActivated=true` / `publicationAllowed=true`.
- Commit secrets, live genesis operator keys, or `.env` files.
- Describe the network as Bitcoin-like, permissionless-finality, or value-bearing.
- Rebrand `zyron-testnet-1` or `zyronchain.onrender.com` as the canonical L1.

## 7. Verification commands

```sh
cd l1
npm ci
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
node scripts/verify-launch-authorization.mjs --policy ../docs/l1-launch-authorization.json --out /tmp/zyron-launch-authorization-result.json

# from repository root
pip install --require-hashes -r requirements.txt
PYTHONPATH=. pytest -q
```
