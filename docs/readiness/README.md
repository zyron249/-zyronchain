# ZyronChain L1 readiness ledger

Machine-readable and human-readable Gate evidence for the standalone TypeScript L1 (`l1/`).

## Truth vocabulary (do not invent softer labels)

| Label | Meaning |
|---|---|
| `INTERNAL PASS` | Local engineering qualification on this tree passed stated commands. Not an independent audit. |
| `PREPARED` | Code/docs/templates exist; activation or external evidence is still missing. |
| `BLOCKED` | Correctly not ready; must not activate. |
| `EXTERNAL EVIDENCE REQUIRED` | Needs independent humans, hosts, HSM, soak, or audit artifacts not inventable in-repo. |
| `HUMAN DECISION REQUIRED` | Policy/allocation/economics/validator-set choices reserved for founders/operators. |

## Immutable economics

- `MAX_SUPPLY = 50_000_000 ZYN` forever (`MAX_SUPPLY_ATOMS = 50_000_000 * 1e8`).
- Do not invent hosts, allocations, chain IDs, HSM evidence, or claim independent audit.
- Do not auto-merge consensus PRs.
- Do not flip `publicTestnetActivationAllowed` / `mainnetActivationAllowed` (both remain `false`).

## Files

| File | Role |
|---|---|
| `GATE0_BASELINE.md` | Gate 0 human report (commands, results, open PRs, risks) |
| `GATE0_LEDGER.json` | Gate 0 machine-readable ledger |
| `readiness-matrix.json` | Cross-gate readiness matrix snapshot |

## Priority consensus PRs (do not merge without explicit human approval)

- `#903` — public testnet scaffold (draft)
- `#904` — round-change liveness (draft; stacks on `#903`)
