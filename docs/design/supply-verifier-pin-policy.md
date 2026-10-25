# Supply-verifier pin policy (threat-model proposal)

Status: **threat-model comparison. Decision recorded below: rule A kept.**

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

## Decision

Patron kept rule A, with no exception.

## Interim policy (in force now)

Batch `l1/src` changes inside ONE PR. Run `npm run pin-hash` once at the end of that
PR, and Security does one independent rebuild before merge.

## Documented alternative (not adopted)

Option B stays documented as the alternative only. If it is ever adopted, Security's
conditions apply: at each release tag, rebuild using the scripts from main at that
tag, and treat a red pin check on main as a release blocker.
