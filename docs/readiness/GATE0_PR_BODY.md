## Summary

Gate 0 baseline for ZyronChain standalone L1 readiness:

- Machine-readable ledger + readiness matrix under `docs/readiness/`
- Immutable **MAX_SUPPLY = 50_000_000 ZYN** invariant tests (`l1/test/supply-invariant.test.ts`)
- Local verification on `main` tip `8794b4e` (Node 22): typecheck / test / audit / root pytest

**Claim level:** internal engineering baseline only. **Not** an independent audit. Does not flip activation flags. Does not invent hosts, allocations, chain IDs, or HSM evidence.

## Test plan

```bash
cd l1 && npm ci && npm run typecheck && npm test && npm audit --omit=dev --audit-level=high
# root: pytest -q
```

Observed this session: **610 pass / 0 fail** (npm test), **0** high+ runtime vulns, **58** pytest passed.

## Consensus priority (not in this PR)

- Draft **#903** public-testnet scaffold — rebase needed onto current main
- Draft **#904** round-change liveness (stacks on #903) — Gate 1; **do not auto-merge**

## Risk / honesty

- Round-view-change is **absent on main** → consensus liveness for ambiguous splits remains a public-testnet blocker until #904 is reviewed.
- Independent audit / HSM / independent operators / public soak: **EXTERNAL EVIDENCE REQUIRED**
- Genesis / token distribution / validator set: **HUMAN DECISION REQUIRED**
- `publicTestnetActivationAllowed` and `mainnetActivationAllowed` remain **false** (correct)

## Checklist

- [x] No activation flag flips
- [x] No invented hosts / allocations / chain IDs
- [x] No independent-audit claim
- [x] Consensus code unchanged (Gate 1 owns #904)
- [ ] Human review before merge
