# ZyronChain standalone L1 external-audit package

Status: **audit preparation only**. This package does not claim that an independent security audit has occurred and does not itself activate public testnet, public mining or mainnet.

## Audit target

The canonical consensus implementation is the standalone TypeScript L1 under `l1/`. The historical Python/Flask network is not part of the consensus audit target except where an auditor explicitly chooses to examine migration or operator-confusion risk.

The machine-readable scope is `docs/l1-audit-scope.json`. CI validates that every security invariant points only to an explicitly listed critical module and produces a commit-bound manifest containing SHA-256 digests for every critical module, security specification, independent verifier input and required evidence/control workflow.

Protocol v5 permissionless proof-of-work issuance is part of the audit target. It does **not** replace the permissioned validator finality layer: miners compete for ZYN issuance while validators still propose, attest and finalize blocks. Protocol v4 remains intentionally unsupported/fail-stop.

## Required independent review

At minimum, an external review should independently analyze:

1. >2/3 finality, proposer selection, skip-certificate view changes and all quorum-boundary cases;
2. validator anti-equivocation journal ordering, crash ambiguity and local/remote signer behavior;
3. transaction, governance, block, attestation, round-skip and protocol-v5 mining signing/replay domains across protocol versions;
4. protocol-v5 mining challenge binding, 20-bit target comparison, stale-tip behavior, miner-identity binding, deterministic reward schedule, one-claim-per-block rule and the global finalized mining-claim counter;
5. the immutable 50M historical genesis-plus-mining issuance ceiling, zero-premine profile, genesis-budget subtraction, fee-burn permanence and reserved tracker-address isolation;
6. mining-mempool resource policy, 256-claim bound, proof-priority replacement, claim-race behavior and the requirement that mining traffic cannot evict normal transfers;
7. mining hardware skew, pool concentration, validator claim-censorship and fixed-target versus retarget assumptions before mainnet calibration;
8. secp256k1 usage, canonical encoding, hashing/Merkle construction and key/address binding;
9. State-v2 authenticated persistence, miner/tracker commitments, membership/non-membership semantics, checkpoint/state-sync trust anchors, pruning/recovery boundaries and the 100k-account scale evidence limits;
10. native libp2p Noise identity binding, discovery/admission, peer diversity/scoring, sync protocols, frame/work/byte limits and eclipse/Sybil assumptions;
11. RPC consensus authentication, signed-body preflight, exact trusted-proxy enforcement, concurrency/body/response resource budgets and malformed-input behavior, including the standalone miner's bounded HTTPS/loopback RPC behavior;
12. validator-set/protocol upgrade authorization, delayed activation, v4 unsupported-version fail-stop, v5 activation and rollback semantics;
13. independent light-client verification and validator-transition proof assumptions;
14. release dependency/SBOM/provenance workflow, inclusion of the standalone miner in the release tarball, clean release-artifact third-party operation and all production-operation assumptions described by the threat model/runbook;
15. independent-operator challenge/evidence semantics, including the explicit boundary that project CI cannot prove operator independence;
16. Render/hosting-profile assumptions, including why the Free profile is smoke-only and why sustained uptime evidence requires reviewed always-on infrastructure;
17. hosted duration-soak evidence semantics, including monotonic finality, memory/readiness/fault bounds and the rule that synthetic vectors cannot prove real uptime;
18. security disclosure, maintainer/release/domain/checkpoint succession and founder-exit assumptions, including whether any unique personal credential or founder-only private context remains operationally necessary;
19. launch authorization versus activation gating, including verification that governance authorization does not waive independent mining calibration/retest, audit, operator, custody, genesis/economics or infrastructure requirements.

## Reproduction baseline

From `l1/`, an auditor should be able to run:

```sh
npm ci
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
npm sbom --omit=dev --sbom-format=spdx > runtime-sbom.spdx.json
```

The exact Node.js policy comes from `l1/package.json`; project CI exercises the supported Node 22 and 24 lines. The independent Python verifier is intentionally separate from the TypeScript implementation and has its own pinned dependency hashes.

Mining operator behavior can additionally be inspected with:

```sh
npm run mine -- --help
```

A packaged release must contain `scripts/mine.mjs` and `MINING.md`; the miner decrypts/signs locally and remote RPC requires HTTPS.

## Commit-bound audit artifact

`Standalone L1 External Audit Pack CI` builds `audit-pack.json` from the reviewed checkout. The artifact includes:

- exact GitHub commit checked out by the job;
- audit-scope SHA-256;
- path, byte count and SHA-256 for each critical source/specification/verifier/control file, including the mining module and packaged miner;
- public security/succession, launch-authorization, mining and hosting-policy files;
- release-artifact operator rehearsal, independent-operator challenge, State-v2 scale evidence and hosted duration-soak tooling/workflows/test vectors;
- L1 package name/version and Node engine policy;
- invariant/evidence/external-gate inventory;
- runtime SPDX SBOM;
- `SHA256SUMS` over the audit package, scope and SBOM.

The generator fail-closes if the required evidence inventory or any required verifier/workflow path disappears. The pack is deterministic for the same checkout/runtime metadata and is retained as a GitHub Actions artifact. An auditor must still independently obtain/verify the repository commit and should not treat a project-produced artifact as an independent attestation.

## Existing evidence to inspect

Current project CI or policy artifacts cover:

- historical mixed-version upgrade/rollback with v4 retained as an unsupported fail-stop boundary;
- protocol-v5 activation, bounded proof-of-work search, mining transaction validation, finalized 6.25 ZYN issuance, stale-tip rejection and double-claim rejection;
- mining reward/halving/cap unit invariants and tracker-address isolation;
- bounded public mining mempool policy;
- checkpoint disaster recovery;
- 600-height composite adversarial consensus soak;
- separate-process native P2P SIGKILL/recovery;
- quorum-authorized validator signing-key replacement;
- clean installation and operation from the packaged release artifact without source-tree runtime files;
- an independent-operator challenge whose verifier deliberately keeps `independenceProven=false` until genuine external evidence is reviewed;
- 100,000-account State-v2 restart/GC/root/cache regression evidence, which does **not** replace release-hardware capacity evidence;
- the connected Render Free profile's smoke-only hosting classification;
- a hosted duration-soak evidence verifier with synthetic positive/negative CI vectors; synthetic output deliberately keeps real uptime evidence false;
- governance authorization for public testnet/mainnet with separate activation gates;
- deterministic maintainer/security succession policy evidence.

These are regression/policy evidence, not a substitute for an external audit, real multi-miner contention/calibration, actual independent custody, real always-on hosted evidence, or sustained independent-operator Internet testnet evidence.

## Finding handling

Every audit finding should record: severity, affected invariant(s), affected commit, exploit/precondition, reproduction, remediation PR, regression test/evidence, and independent retest status. **Critical/high findings are stop-ship** until independently confirmed closed. Quorum thresholds, signing journals, mining cap/target checks, trust anchors, resource bounds or validation checks must never be weakened merely to make a finding disappear.

## Explicitly outside autonomous finalization

This audit package deliberately does not choose or freeze:

- mainnet chain ID or final genesis allocation profile;
- final mainnet mining target/retarget calibration beyond the implemented v5 testnet baseline;
- validator reward/inflation/fee economics;
- production activity-oracle governance;
- production HSM/signer provider and custody ceremony;
- validator admission/decentralization policy;
- real successor identities, private contact addresses, repository/release/domain credentials or custody assignments;
- any redesign from the current validator-finality architecture to Nakamoto-style proof-of-work chain selection.

Governance authorization may exist for a network class while these activation requirements remain open. Protocol-v5 issuance mining being implemented does not authorize public mining. Those items require separate human/governance, operational, independent-audit or real-network evidence before value-bearing activation.
