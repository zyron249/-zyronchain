# ZyronChain

ZyronChain is an independently verifiable account-based Layer-1 blockchain under active pre-launch development.

The **canonical consensus implementation** is the standalone TypeScript L1 in [`l1/`](l1/README.md). It provides deterministic state execution, authenticated State-v2 commitments, >2/3 validator finality, certified view changes, protocol-versioned upgrades and rollback, Noise-authenticated libp2p networking, checkpoint/state sync, light-client proofs, remote-validator signing and reproducible release artifacts.

## Network status

**Public testnet and mainnet governance authorization have been granted.** The machine-readable authority is [`docs/l1-launch-authorization.json`](docs/l1-launch-authorization.json) and the human-readable policy is [L1 Launch Authorization](docs/L1_LAUNCH_AUTHORIZATION.md).

Authorization is not the same as activation or certification. The authorization policy currently records `publicTestnetAuthorized=true` and `mainnetAuthorized=true`, while keeping `publicTestnetActivationAllowed=false` and `mainnetActivationAllowed=false` until the corresponding readiness evidence is independently closed.

The currently deployed internal profile remains a **private/adversarial-development network**. The existing Render Free/private-adversarial profile remains smoke-only and non-value-bearing; it is not automatically promoted into the canonical public testnet or mainnet by this authorization.

Historical policy note: the former repository statement `No ZyronChain public testnet or value-bearing mainnet is authorized by this repository` is obsolete and retained here only so older audit/preflight tooling can detect the policy transition explicitly rather than silently losing the previous safety language.

The historical Python/Flask Proof-of-Work network and its explorer are a **legacy compatibility testnet**, not the canonical chain. Its preserved documentation is in [Legacy Python/Flask Testnet](docs/LEGACY_PYTHON_TESTNET.md).

## Canonical implementation

- Source: [`l1/src/`](l1/src)
- Operator and protocol guide: [`l1/README.md`](l1/README.md)
- Readiness gate: [`docs/STANDALONE_L1_READINESS.md`](docs/STANDALONE_L1_READINESS.md)
- Launch authorization: [`docs/L1_LAUNCH_AUTHORIZATION.md`](docs/L1_LAUNCH_AUTHORIZATION.md)
- Operations and disaster recovery: [`docs/L1_OPERATIONS_RUNBOOK.md`](docs/L1_OPERATIONS_RUNBOOK.md)
- Threat model: [`docs/L1_THREAT_MODEL.md`](docs/L1_THREAT_MODEL.md)
- Security disclosure: [`SECURITY.md`](SECURITY.md)
- Maintainer and security succession: [`docs/L1_MAINTAINER_SUCCESSION.md`](docs/L1_MAINTAINER_SUCCESSION.md)
- Technical paper: [`WHITEPAPER.md`](WHITEPAPER.md)
- Historical audit: [`docs/ZYRONCHAIN_MAINNET_AUDIT_2026-08-08.md`](docs/ZYRONCHAIN_MAINNET_AUDIT_2026-08-08.md)

## Build and verify

The canonical client requires Node.js 22 or newer.

```sh
cd l1
npm ci
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
```

CI repeats the test suite on Node.js 22 and 24 and runs the independent Python light-client verifier. Tags matching `l1-v*` build checksummed tarballs, an SPDX SBOM and GitHub artifact attestations. Release artifacts are engineering evidence; they do not constitute activation approval.

## Safety position

ZyronChain currently uses an explicitly permissioned validator set. Governance authorization does not make the network Bitcoin-like, permissionless, founder-independent or battle-tested. Those claims still require independent operators, validator admission/governance, production key custody, adversarial soak testing, external audits and immutable launch specifications with public evidence.

No hidden administrator, recovery or minting authority should be introduced. Genesis allocation, validator admission, activity-oracle governance and reward policy remain explicit launch decisions and will not be silently invented in code.

Maintainer succession likewise cannot be satisfied by naming placeholder accounts. Before public-testnet activation, independent custodians must demonstrate the repository/release/security/domain continuity evidence defined by the public succession policy; repository maintainership never bypasses validator or protocol quorum rules.

## Repository layout

| Path | Status |
|---|---|
| `l1/` | Canonical standalone L1 |
| `docs/` | Readiness, threat model, audits and operational evidence |
| `app.py`, `zyron/`, `templates/`, `static/` | Legacy Python/Flask compatibility testnet |
| `tests/` | Legacy Python testnet tests |
| `l1/test/` | Canonical L1 tests |

## Contributions and launch discipline

Security and consensus changes must preserve deterministic replay and include regression evidence. Security reports follow [`SECURITY.md`](SECURITY.md); maintainer/release continuity follows [`docs/L1_MAINTAINER_SUCCESSION.md`](docs/L1_MAINTAINER_SUCCESSION.md). Do not deploy generated keys, genesis files or operator secrets from this repository. Do not activate or advertise a value-bearing mainnet until the activation gates in the launch authorization/readiness policies are independently closed.
