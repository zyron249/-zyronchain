# ZyronChain

ZyronChain is an independently verifiable account-based Layer-1 blockchain under active pre-launch development.

The **canonical consensus implementation** is the standalone TypeScript L1 in [`l1/`](l1/README.md). It provides deterministic state execution, authenticated State-v2 commitments, >2/3 validator finality, certified view changes, protocol-versioned upgrades and rollback, Noise-authenticated libp2p networking, checkpoint/state sync, light-client proofs, remote-validator signing and reproducible release artifacts.

## Network status

**No ZyronChain public testnet or value-bearing mainnet is authorized by this repository.**

The canonical L1 is currently a private/adversarial-development network. Passing CI does not authorize a public launch. A public testnet will remain blocked until the code, threat model, fault-injection suite and independent-operator package satisfy the gates in [Standalone L1 Readiness](docs/STANDALONE_L1_READINESS.md).

The historical Python/Flask Proof-of-Work network and its explorer are a **legacy compatibility testnet**, not the canonical chain. Its preserved documentation is in [Legacy Python/Flask Testnet](docs/LEGACY_PYTHON_TESTNET.md).

## Canonical implementation

- Source: [`l1/src/`](l1/src)
- Operator and protocol guide: [`l1/README.md`](l1/README.md)
- Readiness gate: [`docs/STANDALONE_L1_READINESS.md`](docs/STANDALONE_L1_READINESS.md)
- Operations and disaster recovery: [`docs/L1_OPERATIONS_RUNBOOK.md`](docs/L1_OPERATIONS_RUNBOOK.md)
- Threat model: [`docs/L1_THREAT_MODEL.md`](docs/L1_THREAT_MODEL.md)
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

CI repeats the test suite on Node.js 22 and 24 and runs the independent Python light-client verifier. Tags matching `l1-v*` build checksummed tarballs, an SPDX SBOM and GitHub artifact attestations. Release artifacts are engineering evidence; they do not constitute launch approval.

## Safety position

ZyronChain currently uses an explicitly permissioned validator set. It must not be described as Bitcoin-like, permissionless or founder-independent until independent operators, validator admission/governance, production key custody, adversarial soak testing, external audits and an immutable genesis/economic specification exist with public evidence.

No hidden administrator, recovery or minting authority should be introduced. Genesis allocation, validator admission, activity-oracle governance and reward policy are public launch decisions and will not be silently invented in code.

## Repository layout

| Path | Status |
|---|---|
| `l1/` | Canonical standalone L1 |
| `docs/` | Readiness, threat model, audits and operational evidence |
| `app.py`, `zyron/`, `templates/`, `static/` | Legacy Python/Flask compatibility testnet |
| `tests/` | Legacy Python testnet tests |
| `l1/test/` | Canonical L1 tests |

## Contributions and launch discipline

Security and consensus changes must preserve deterministic replay and include regression evidence. Do not deploy generated keys, genesis files or operator secrets from this repository. Do not call any network “mainnet” until every stop-ship gate is independently closed.
