# Gate 1 — Round-change liveness (status)

- **As of:** 2026-09-27T04:40:00-04:00 (America/New_York)
- **Branch:** `cursor/round-view-change-liveness-068e` (rebased onto `main` @ `8794b4e`)
- **Stack:** self-contained — includes rebased `#903` scaffold commits + consensus commits + Gate 0 supply/ledger cherry-pick + Gate 1 adversarial tests
- **Companion:** `cursor/public-testnet-identity-scaffold-70eb` also rebased onto `main` (separate tip hashes after independent rebase; `#904` remains self-contained)
- **Draft:** keep draft; **do not merge**; **do not auto-merge**; activation flags untouched

## Rebase note

`#903`/`#904` previously based on `f33e982`. Main advanced 10 website/Mini App commits with **no `l1/` drift**. Both branches rebased cleanly onto current main.

## Internal audit focus (this session)

| Property | Result |
|---|---|
| Quorum `floor(2N/3)+1` for N=3,4,7,10,25,50 | INTERNAL PASS (unit) |
| Prepare/commit + view-change lock rules | INTERNAL PASS candidate (existing + gate1 adversarial) |
| Finality never by timeout/view-change alone | INTERNAL PASS (S9 + gate1) |
| Missing votes not yes/no | INTERNAL PASS (gate1) |
| Unknown validators weight 0 | INTERNAL PASS (gate1) |
| No plurality finalize on 2+2 / 3+3+1 | INTERNAL PASS (regression + gate1) |
| Bounded search double-finalize = 0 for N=3,4,7 | INTERNAL PASS |
| Crash/fsync / journal fail-closed | INTERNAL PASS candidate (existing extended qualification) |
| No double-sign after recovery | INTERNAL PASS candidate (existing journal/crash suites) |
| Independent audit | EXTERNAL EVIDENCE REQUIRED |

## Claim level

**Internal engineering qualification** only when local commands below pass. **Not** an independent audit. **Not** public-testnet activation.

## Commands

```bash
cd l1
npm ci && npm run typecheck && npm test
npm audit --omit=dev --audit-level=high
node --test --test-timeout=600000 \
  dist/test/round-double-hash-liveness-regression.test.js \
  dist/test/consensus-safety-invariants.test.js \
  dist/test/split-vote-liveness.test.js \
  dist/test/consensus-1-1-qualification.test.js \
  dist/test/consensus-extended-qualification.test.js \
  dist/test/gate1-adversarial-consensus.test.js \
  dist/test/supply-invariant.test.js \
  dist/test/mining-economics-pin.test.js
```

## Unresolved risks

1. Human review of consensus PR still required before any merge consideration.
2. Mixed 1.0/1.1 unsupported — homogeneous upgrade required.
3. Independent audit / HSM / independent operators / public soak still EXTERNAL.
4. Genesis / allocations / validator set still HUMAN DECISION REQUIRED.
5. Push from this box may be blocked without GitHub credentials.


## Observed this session (local box)

| Command | Result |
|---|---|
| `npm run typecheck` | PASS |
| `npm test` | **690 pass / 0 fail**, duration ≈ 52608 ms |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |
| Focused consensus + gate1 + supply + economics pin | 34+7 pass earlier in session; included in full suite |
| Flakes | none observed |

CRITICAL/HIGH consensus defects found this session requiring code fixes: **none**. Adversarial coverage extended with reviewable unit tests only.
