## Summary

Gate 1 advancement on draft round-change liveness (`#904`):

- **Rebased** onto current `main` (`8794b4e`). Stack is **self-contained** (includes `#903` scaffold commits). Companion `#903` branch also rebased separately (tip hashes diverge after independent rebase; this PR remains self-contained).
- Cherry-picked Gate 0 readiness ledger + **MAX_SUPPLY = 50_000_000 ZYN** invariant tests.
- Added `l1/test/gate1-adversarial-consensus.test.ts` (unknown validators weight 0, missing votes not yes/no, 2+2 / 3+3+1 refuse plurality finalize, timeout/view-change non-finality, duplicate prepare padding, quorum bounds N=3..50, bounded search N=3/4/7).
- Docs: `docs/readiness/GATE1_STATUS.md`, honest limitations update.

**Keep draft. Do not merge. Do not auto-merge.** Activation flags remain `false`.

## Claim level

**Internal engineering qualification** only (when local commands pass). **Not** an independent audit. **Not** public-testnet/mainnet activation.

## Test plan

```bash
cd l1
npm ci && npm run typecheck && npm test
npm audit --omit=dev --audit-level=high
```

Plus focused consensus files listed in `docs/readiness/GATE1_STATUS.md`.

## Risk / honesty

- Independent audit / HSM / independent operators / public soak: **EXTERNAL EVIDENCE REQUIRED**
- Genesis / allocations / validator set: **HUMAN DECISION REQUIRED**
- Mixed consensus 1.0/1.1 unsupported
- Cohort N=10/25/50 tests are accounting reconcilers, not OS-process validator farms

## Checklist

- [x] Rebased onto current main
- [x] No activation flag flips
- [x] No invented hosts / allocations / chain IDs / HSM evidence
- [x] No independent-audit claim
- [x] MAX_SUPPLY forever 50M locked by tests
- [ ] Human consensus review before any merge consideration
