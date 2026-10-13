# ZyronChain community bug bounty (testnet)

> **Status:** Reward amounts will be announced before any mainnet launch; no rewards are currently offered.

> **Read this first.**
> - ZyronChain has **not** had a professional security audit. All reviews to date are self-reviews and AI-assisted reviews. They are not audits and must not be described as audits.
> - The public testnet uses test ZYN that has **no value**. It cannot be bought or sold and is not redeemable for mainnet ZYN.
> - There is no mainnet. A mainnet may never launch.
> - Rewards are **not** money and are **not** guaranteed to have any monetary value. See [Rewards](#rewards).

## 1. Purpose

ZyronChain is a standalone Layer 1 written in TypeScript. The project has no budget for a paid audit, so it asks the community for help. This program sets out what to test, how to report, how findings are rated, and how the project may recognise valid findings.

## 2. Scope

### 2.1 In scope

The target is the `main` branch of <https://github.com/zyron249/-zyronchain> at the time of your report. Name the exact commit you tested in your report.

| Area | Where | What we care about most |
|---|---|---|
| Consensus: protocol v6 (locked two-phase BFT, prepare/commit votes, timeout certificates, view change) | `l1/src/consensus-v6.ts`, `l1/src/v6-scheduler.ts`, `l1/src/consensus-state-store.ts`, `l1/src/node.ts`, `l1/src/node-base.ts`, `l1/src/block.ts`, `l1/src/p2p-consensus.ts` | Two conflicting blocks finalized at one height; finality without a valid quorum; an honest validator made to equivocate |
| Validator signing and anti-equivocation (signing journal, crash recovery, remote signer client) | `l1/src/storage.ts`, `l1/src/validator-signer.ts`, `l1/src/remote-signer-service.ts` | A signature released before its reservation is durable; a journal state that lets a validator sign two values for one height, round and step |
| Fixed supply (50,000,000 ZYN at genesis, no mining) | `l1/src/tokenomics.ts`, `l1/src/mining.ts`, `l1/src/chain.ts`, `l1/src/state.ts`, `l1/src/state-v2.ts`, `l1/src/mempool.ts` | Any way to create ZYN after genesis, or to get a `mining_claim` accepted on any path or protocol version |
| Founder vesting and permanent-liquidity lock | `l1/src/allocation-locks.ts`, `l1/src/founder-vesting.ts`, enforcement in `chain.ts`, `state.ts`, `state-v2.ts`, `node-base.ts` | Spending locked founder funds early; any outflow from the permanent-liquidity account |
| Activity oracle and its cap (10,000 ZYN per rolling 24 h under `launchProfile: "fixed-supply-v1"`) | `l1/src/activity.ts`, `l1/src/activity-oracle.ts`, `chain.ts`, `state.ts`, `state-v2.ts`, `transaction.ts` | Settling more than the cap in any 24 h window; settling out of order; bypassing the oracle signature threshold; crediting the activity pool |
| Genesis identity and configuration binding | `l1/src/block.ts`, `chain.ts` | Two different `fixed-supply-v1` genesis configurations with the same genesis hash |
| Trusted snapshot, checkpoint and state sync | `chain.ts`, `storage.ts`, `p2p-checkpoint.ts`, `p2p-state.ts`, `state-v2*.ts` | Installing state that was never finalized; bricking a node through a sync peer |
| Cryptography and encoding | `l1/src/crypto.ts`, `codec.ts`, `merkle.ts`, `transaction.ts`, `keystore.ts` | Signature forgery or malleability that changes a transaction ID; domain-separation gaps; canonical-encoding ambiguity |
| Networking, RPC and resource bounds | `l1/src/p2p*.ts`, `peer-*.ts`, `rpc-rate-limit.ts`, RPC handlers in `node-base.ts` | Remote crash, unbounded memory or CPU from a small input, authentication bypass |
| Governance (validator set and protocol upgrades) | `chain.ts`, `transaction.ts`, `cli-governance-file.ts` | Changing the validator set or protocol version without current-set quorum or without the activation delay |
| Light clients | `l1/src/light-client.ts`, `l1/independent-light-client/` | A light client that accepts a header the full node would reject |
| Open testnet profile and its public gateway | `l1/scripts/open-testnet.mjs`, `deploy/open-testnet/` | Reaching a consensus, governance or block-acceptance endpoint through the gateway; submitting a transaction for another chain ID; bypassing faucet limits in a way that is not plain volume |
| Build, CI and release supply chain | `.github/workflows/`, `l1/package-lock.json`, release scripts | Anything that lets an outsider change what CI builds, tests or publishes |

The written security properties that reports can be checked against are listed in `docs/l1-audit-scope.json` (`securityInvariants`, IDs such as `CONS-003`, `SIGN-003`, `SUPPLY-001` to `SUPPLY-004`, `MINING-001`, `GOV-001`). A report that shows one of these statements is false is the most useful kind of report.

### 2.2 Out of scope

- The legacy Python/Flask stack (`app.py`, `main.py`, `zyron/` and its docs). It is not the canonical chain.
- `telegram-game/`, the website, the PWA wallet and the MetaMask Snap. Please report bugs in these as normal GitHub issues; they are not part of this program.
- Miner packaging and release tooling. Mining is retired. Only the **rejection** of `mining_claim` is in scope.
- Third-party services and infrastructure, including the hosting provider of the public testnet, GitHub, npm, and any service not run by the project.
- Volumetric denial of service (flooding, high request rates, botnets). Resource-exhaustion bugs where a **small** input causes **disproportionate** cost are in scope; show them on a local copy.
- The public testnet resetting to a new genesis on a cold start. This is known and expected (see `docs/OPEN_TESTNET.md`).
- Behaviour of a genesis file **without** `launchProfile: "fixed-supply-v1"` that the docs already describe as unprotected (`docs/FIXED_SUPPLY_TOKENOMICS.md`, `docs/GENESIS_CONFIG_BINDING.md`). A public launch is planned to use that profile.
- Issues already documented in the repository as known issues or accepted risks when you report them (for example in `docs/CONSENSUS_CERTIFICATE_MODEL.md`), unless you show a new impact.
- Networks with 2 or 3 validators losing liveness after a single fault. They have no fault tolerance by design.
- Findings that need a compromised validator quorum, a stolen private key, physical access, or a modified node binary on the victim side.
- Missing best-practice headers, banner or version disclosure, clickjacking on pages with no sensitive actions, and similar findings without a demonstrated security impact.
- Reports produced by scanners or AI tools that the reporter has not reproduced. See the [PoC requirement](#4-proof-of-concept-requirement).

If you are unsure whether something is in scope, report it privately and ask.

## 3. Severity tiers

Severity is based on the impact the bug **would have on a value-bearing network** that runs the same code with a `fixed-supply-v1` genesis and at least 4 validators, even though today only a no-value testnet exists. The project triages each report and may change its severity. The reasons are written down in the advisory.

| Tier | Criteria (any one is enough) | Examples |
|---|---|---|
| **Critical** | Breaks safety or supply without needing a validator quorum or any stolen key: | Two conflicting blocks finalized at the same height with at most f faulty validators; ZYN created after genesis; any debit from the permanent-liquidity account; founder funds spent before they vest; settling more than 10,000 ZYN of activity payouts in a 24 h window under `fixed-supply-v1`; finality or a state root accepted without a valid quorum; remote code execution on a node |
| **High** | Breaks a consensus or custody rule only under narrower conditions, or permanently halts the network: | Making an honest validator sign two conflicting values; changing the validator set or protocol version without quorum or without the activation delay; installing never-finalized state through snapshot, checkpoint or state sync; a remote input that permanently stops finality for all honest validators; a light client that accepts a forged header; an outsider changing what CI builds or publishes |
| **Medium** | Temporary loss of availability or a weaker integrity break with clear limits: | A small remote input that crashes a node or causes disproportionate CPU or memory use; a sync peer that forces a node into an unrecoverable state that needs a manual resync; a gateway bypass that reaches an endpoint documented as not exposed; a bypass of the oracle signature threshold that is still held by the cap |
| **Low** | Limited impact or strong preconditions: | A faucet limit bypass; an operator CLI that writes an invalid file without warning; a fail-stop that needs operator action but loses no safety; minor information disclosure |
| **Informational** | No direct security impact: | Documentation that overstates a guarantee; missing tests for a security rule; hardening suggestions |

Critical and High findings that affect consensus, cryptography, authenticated state, validator signing, supply, checkpoint trust or remote attack surfaces are release blockers under `SECURITY.md`.

## 4. Proof-of-concept requirement

A report is eligible for a reward only if it includes a working proof of concept that the project can run. Please include:

1. The commit hash you tested.
2. The affected file(s) and function(s), and the invariant ID from `docs/l1-audit-scope.json` it breaks, if there is one.
3. A self-contained reproduction. The best form is a test that fails on the tested commit, written with `node --test` in the style of `l1/test/`, or a script that runs against a **local** network (`node scripts/open-testnet.mjs init` / `run`, or `npm run devnet`).
4. The exact commands, the expected result and the actual result.
5. The impact, and the severity you think it has, with your reasons.
6. A suggested fix, if you have one (optional).

Do not include real private keys, passwords, seed phrases or tokens. The testnet only uses throwaway test keys. AI tools may help you, but you must run and check the PoC yourself before you report. Unverified output from a scanner or AI tool is not eligible.

## 5. How to report (responsible disclosure)

Report privately through **GitHub private vulnerability reporting**:

<https://github.com/zyron249/-zyronchain/security/advisories/new>

(Repository → **Security** tab → **Report a vulnerability**.)

- Do **not** open a public issue, pull request, discussion or social media post about an unfixed vulnerability.
- One vulnerability per report. If several bugs chain together, report the chain once and list each step.
- If you cannot use GitHub private reporting, open a public issue that only asks for a private contact. Do not put any details in it.

**What we aim to do** (goals, not guarantees; the project is small and run by volunteers):

| Step | Target |
|---|---|
| Acknowledge the report | 3 business days |
| First severity and ownership assessment | 7 business days |
| Status updates | at least every **14** days while the report is open |
| Coordinated public disclosure | when a fix and operator guidance are available, or **90** days after the report, whichever comes first, unless both sides agree to a different date |

Fixes are made in the open repository with a regression test. The advisory credits you (name or handle of your choice) unless you ask to stay anonymous.

## 6. Rules of engagement

1. **Testnet only.** Test only against the public no-value testnet or, better, your own local copy. There is no mainnet. Do not test against any network that claims to be a ZyronChain mainnet.
2. **Prefer a local copy.** Run anything heavier than a few requests (fuzzing, resource-exhaustion tests, consensus attacks) on your own copy (`docs/OPEN_TESTNET.md`, "Run your own copy"). The public gateway runs on a small free host and is shared with other testers.
3. **No harm to others.** Do not attack infrastructure that belongs to anyone else: the hosting provider, GitHub, npm, other testers' nodes, or any third party.
4. **No denial of service** against the public testnet, and no automated high-volume traffic against it.
5. **No social engineering**, phishing or impersonation of maintainers, contributors or other users. No physical attacks.
6. **No privacy violations.** Do not access, change or keep other people's data. If you see data that is not yours, stop and include it in your report.
7. **Do not draw down shared resources on purpose.** Use the faucet only for what your test needs, and do not try to drain it.
8. **Keep it confidential** until coordinated disclosure (section 5).
9. **No extortion.** Demanding a payment or reward in return for not disclosing a bug disqualifies the report and is not covered by safe harbor.
10. Follow the law that applies to you.

## 7. Safe harbor

If you make a good-faith effort to follow this policy while researching and reporting a vulnerability, the project:

- considers your research authorised under this policy;
- will not start or support legal action against you for that research, including claims under anti-hacking or anti-circumvention laws, or for breaking the terms of use of project-run services;
- will say publicly, if a third party takes legal action against you for research that followed this policy, that you acted under this policy.

Good faith means: you stayed inside the rules in section 6, you stopped and reported as soon as you found a vulnerability, you did not use it beyond what was needed to show it, and you kept it confidential until disclosure.

This safe harbor covers only systems and code that the project controls. It cannot authorise testing of third-party systems (for example the hosting provider or GitHub). Their own policies apply. If in doubt, ask first through a private advisory.

This section has not been reviewed by a lawyer.

## 8. Rewards

### 8.1 What a reward is

- Rewards are paid in **ZYN**, out of the existing **5,000,000 ZYN ecosystem/community reserve** that is defined at genesis.
- **No new ZYN is created.** Total supply stays fixed at 50,000,000 ZYN, and rewards do not change it.
- Rewards are paid **only after the project has decided to launch a mainnet**, and only on that mainnet. If no mainnet launch decision is ever made, **no reward is paid**.
- Test ZYN on the testnet is never a reward and has no value.
- **No monetary value is promised or implied.** ZYN may never be tradable and may never have any market value. A reward is not payment for services, not an investment and not a claim on the project.
- Rewards are recorded publicly when a finding is accepted (advisory ID, severity, reward in ZYN) so that the eventual payout can be checked by anyone.
- Payouts follow the on-chain rules that apply to the reserve at the time. The payout method will be announced together with the reward amounts.

### 8.2 Amounts

Reward amounts will be announced before any mainnet launch; no rewards are currently offered.

Informational findings receive public credit only.

### 8.3 Eligibility

- The first valid report of an issue is eligible. Later duplicates are credited but not rewarded.
- The report must meet the PoC requirement (section 4) and follow the rules (section 6).
- Issues that were already known to the project (in a public issue, a pull request, a document or an open advisory) before your report are not eligible.
- The project decides the final severity and reward. The reasons are written in the advisory.
- Current maintainers and people with commit access are not eligible.
- You must be able to receive ZYN legally where you live. The project may be unable to pay rewards to people in some jurisdictions or on sanctions lists.
- You need to give a ZyronChain address (public address only) at payout time. Never send a private key.

## 9. Changes to this program

This program may be changed or ended at any time. Changes are made in the public repository, so the history is visible. Changes do not reduce the reward for a report that was accepted before the change.
