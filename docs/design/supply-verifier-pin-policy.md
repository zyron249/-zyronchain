# Supply-verifier pin policy (threat-model proposal)

Status: **proposal for Security review. Not a decision.** The current rule in
`CONTRIBUTING.md` stays in force until Patron decides otherwise.

## Background

`tools/supply-verifier/EXPECTED_SHA256` pins the SHA-256 of the reproducible
supply-verifier tarball. The build includes `l1/src/**`, so almost every core PR
changes the hash. CI (`supply-verifier-reproducible.yml`) runs on `pull_request`
against the test merge with main; `npm run pin-hash` recomputes the pin.

## Options

**A (current).** Enforce the pin on every PR that touches the path filter. Every
pin bump needs an independent Security rebuild on the merged tree (with main's
scripts when `tools/supply-verifier/*.mjs` changes).

**B.** Enforce the pin only on pushes to main and on release tags. On PRs the check
computes the hash and reports it as info (job summary), without failing.

## Risk comparison

| Risk | A | B |
|---|---|---|
| Rubber-stamped bump | High: bumps are frequent, reviewers get used to them | Lower: bumps happen once per release |
| Stale pin on main | Low: blocked at PR time | Higher: main can be red between releases until someone bumps |
| Malicious script edit (`pin-hash.mjs`, `build.mjs`, `hash.mjs` printing a fake hash) | Mitigated by the Security rebuild with main's scripts | Same mitigation needed at tag time; a bad edit could sit on main longer before detection |
| Review burden | High: one Security rebuild per core PR | Low: one rebuild per release |
| Merge-order churn (test merge goes stale as main moves) | High | None on PRs |

Neither option removes the need for an independent rebuild; they differ in how
often it happens and when a mismatch is caught.

## Interim policy (in force now)

Batch `l1/src` changes so there is one pin rebuild per batch: the core PRs of a
batch are reviewed as usual, and the pin is refreshed once, on the last PR of the
batch (or a dedicated pin PR merged last), with one Security rebuild. Open point:
under rule A the pin check fails on the earlier PRs of a batch, so the batch needs
an explicit, recorded exception for that check from Patron.

## Suggested option (proposal only)

B, combined with a protected-branch rule that main is never released with a failing
pin check, and the same Security rebuild rule at each release tag. This is offered
for discussion; the decision belongs to Patron after Security review.
