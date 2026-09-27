# Gate 0 — Baseline readiness (local box)

- **As of:** 2026-09-27T04:25:13-04:00 (America/New_York)
- **Branch:** `readiness/gate0-baseline`
- **Base main tip:** `8794b4e2becc0ae33b2df2fd6824847327e43be6` (`8794b4e` — Website audit polish P1 / #912)
- **Repo:** `https://github.com/zyron249/-zyronchain`
- **Executor:** local box clone at `/workspace/zyron-l1/-zyronchain` (authorized)
- **Claim level:** internal engineering baseline only — **not** an independent audit

## Scope

Gate 0 establishes a truthful baseline of `main`, open priority PRs, CI/workflows, docs, and a green local verification of `l1/` plus root pytest. Consensus design fixes belong on Gate 1 (`#904`), not this branch.

## Checkout

- Shallow clone unshallowed; history depth on main ≈ 993 commits.
- PR heads fetched as `origin/pr/903` and `origin/pr/904`.
- `#903`/`#904` merge-base with main: `f33e982` (10 website/Mini App commits on main since base; **no `l1/` drift** on main since that base → rebase expected to be clean).

## Commands executed on this baseline

Working directory for Node commands: `l1/` with Node **v22.19.0** (engine requires `>=22`).

```bash
cd l1
npm ci
npm run typecheck
npm test
npm audit --omit=dev --audit-level=high
```

Root Python:

```bash
# from repo root, after installing requirements + pytest into an isolated venv
pytest -q
```

### Results (this session)

| Command | Result |
|---|---|
| `npm ci` | OK (131 packages; 0 vulns reported at install) |
| `npm run typecheck` | **PASS** (exit 0) |
| `npm test` (with supply-invariant) | **610 pass / 0 fail**, duration ≈ 51198 ms |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** (exit 0) |
| `pytest -q` | **58 passed** in 4.35s |
| New `l1/test/supply-invariant.test.ts` | **3 pass / 0 fail** (included in 610 above) |

Flakes observed this run: **none**.

## Immutable supply

- `ATOMS_PER_ZYN = 100_000_000`
- `MAX_SUPPLY_ATOMS = 50_000_000 * ATOMS_PER_ZYN` — **forever**
- Gate 0 adds `l1/test/supply-invariant.test.ts` so the 50M cap cannot silently drift without a failing test.

## Main vs priority PRs

| Ref | Tip | Notes |
|---|---|---|
| `main` | `8794b4e` | Website/Telegram Mini App recent; L1 consensus without round-change collector |
| `#903` draft `cursor/public-testnet-identity-scaffold-70eb` | `49b6002` | Public-testnet scaffolds/templates; activation flags stay false; documents N=4/7 double-hash ambiguity; **PREPARED** scaffolds; hosts/genesis **EXTERNAL** |
| `#904` draft `cursor/round-view-change-liveness-068e` | `20f098a` | Stacks on `#903` (+3 consensus commits). Round-change / prepare-commit liveness. Claims internal qualification only. **Do not auto-merge** |
| `#898` draft | launch evidence / deadlock recovery | Lower priority vs consensus |
| `#895` | miner publication evidence | Non-draft; not Gate 0/1 consensus path |
| `#896` | Windows miner GUI | Low priority vs consensus |

`l1/src/round-view-change.ts` is **absent on main** — present only on `#904`.

## Activation flags (unchanged — correct)

From `docs/l1-launch-authorization.json`:

- `publicTestnetAuthorized: true`
- `mainnetAuthorized: true`
- `publicTestnetActivationAllowed: false` ← **must stay false**
- `mainnetActivationAllowed: false` ← **must stay false**
- `authorizationDoesNotWaiveReadinessGates: true`

## Workflows inspected

`.github/workflows/` includes `ci.yml` (Python), `l1.yml` (Node 22/24 typecheck+test+audit+devnet), plus extensive custody/rehearsal/miner/render action-custody policies. Gate 0 does not modify workflows.

## Bugs fixed on main this gate

None. No consensus-orthogonal production bugs were confirmed on `main` during this baseline. Consensus fixes deferred to Gate 1 / `#904`.

## Unresolved risks (honest)

1. **Consensus liveness on main:** ambiguous prepare splits (N=4 2+2, N=7 3+3+1) can refuse completion without a finite round-change path until `#904` is reviewed and merged.
2. **`#903`/`#904` stale vs main tip:** need careful rebase (L1 content unchanged on main since merge-base → low conflict risk; still human-reviewed).
3. **Independent audit:** `EXTERNAL EVIDENCE REQUIRED` — project artifacts are not an audit.
4. **Production HSM / multi-custodian custody:** `EXTERNAL EVIDENCE REQUIRED`.
5. **Public hosts, genesis chain ID, allocations, validator set:** `HUMAN DECISION REQUIRED` / `BLOCKED` — not invented here.
6. **Public testnet / mainnet activation:** `BLOCKED` by policy flags (correct).
7. **GitHub push/PR from this box:** `gh` unauthenticated; push may require a user-provided token (see `PUSH_INSTRUCTIONS.md` if push fails).

## Next gate

**Gate 1** — rebase/recreate `#904` onto current main (preserve stack with `#903` or make self-contained with clear note), aggressive internal audit of round-view-change, extend adversarial/property tests, keep **draft**, never auto-merge, never flip activation flags.
