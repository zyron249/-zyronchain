# ZyronChain standalone L1 external-audit package

Status: **audit preparation only**. This package does not claim that an independent security audit has occurred and does not authorize a public testnet or mainnet launch.

## Audit target

The canonical consensus implementation is the standalone TypeScript L1 under `l1/`. The historical Python/Flask network is not part of the consensus audit target except where an auditor explicitly chooses to examine migration or operator-confusion risk.

The machine-readable scope is `docs/l1-audit-scope.json`. CI validates that every security invariant points only to an explicitly listed critical module and produces a commit-bound manifest containing SHA-256 digests for every critical module, security specification, independent verifier input, `package.json`, and `package-lock.json`.

## Required independent review

At minimum, an external review should independently analyze:

1. >2/3 finality, proposer selection, skip-certificate view changes and all quorum-boundary cases;
2. validator anti-equivocation journal ordering, crash ambiguity and local/remote signer behavior;
3. transaction, governance, block, attestation and round-skip signing/replay domains across protocol versions;
4. secp256k1 usage, canonical encoding, hashing/Merkle construction and key/address binding;
5. State-v2 authenticated persistence, membership/non-membership semantics, checkpoint/state-sync trust anchors and pruning/recovery boundaries;
6. native libp2p Noise identity binding, discovery/admission, peer diversity/scoring, sync protocols, frame/work/byte limits and eclipse/Sybil assumptions;
7. RPC consensus authentication, signed-body preflight, exact trusted-proxy enforcement, concurrency/body/response resource budgets and malformed-input behavior;
8. validator-set/protocol upgrade authorization, delayed activation, unsupported-version fail-stop and rollback semantics;
9. independent light-client verification and validator-transition proof assumptions;
10. release dependency/SBOM/provenance workflow and all production-operation assumptions described by the threat model/runbook;
11. security disclosure, maintainer/release/domain/checkpoint succession and founder-exit assumptions, including whether any unique personal credential or founder-only private context remains operationally necessary.

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

## Commit-bound audit artifact

`Standalone L1 External Audit Pack CI` builds `audit-pack.json` from the reviewed checkout. The artifact includes:

- exact GitHub commit checked out by the job;
- audit-scope SHA-256;
- path, byte count and SHA-256 for each critical source/specification/verifier file, including the public security/succession policy and its verifier;
- L1 package name/version and Node engine policy;
- invariant/evidence/external-gate inventory;
- runtime SPDX SBOM;
- `SHA256SUMS` over the audit package, scope and SBOM.

The pack is deterministic for the same checkout/runtime metadata and is retained as a GitHub Actions artifact. An auditor must still independently obtain/verify the repository commit and should not treat a project-produced artifact as an independent attestation.

## Existing adversarial evidence to inspect

Current CI archives machine-readable evidence for:

- historical mixed-version upgrade/rollback;
- checkpoint disaster recovery;
- 600-height composite adversarial consensus soak;
- separate-process native P2P SIGKILL/recovery;
- quorum-authorized validator signing-key replacement.

A separate deterministic succession-policy artifact verifies that public founder-exit/security-response rules have not silently weakened. It does not prove that independent humans or organizations actually hold the required repository/release/security/domain capabilities.

These are regression/policy evidence, not a substitute for an external audit or sustained independent-operator Internet testnet.

## Finding handling

Every audit finding should record: severity, affected invariant(s), affected commit, exploit/precondition, reproduction, remediation PR, regression test/evidence, and independent retest status. **Critical/high findings are stop-ship** until independently confirmed closed. Quorum thresholds, signing journals, trust anchors, resource bounds or validation checks must never be weakened merely to make a finding disappear.

## Explicitly outside autonomous finalization

This audit package deliberately does not choose or freeze:

- mainnet chain ID or genesis allocation;
- validator reward/inflation/fee economics;
- production activity-oracle governance;
- production HSM/signer provider and custody ceremony;
- validator admission/decentralization policy;
- real successor identities, private contact addresses, repository/release/domain credentials or custody assignments;
- any redesign from the current PoA/BFT architecture to PoW/mining.

Those require separate human/governance, operational or architectural decisions.
