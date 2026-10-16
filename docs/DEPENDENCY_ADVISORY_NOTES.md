# Dependency advisory notes

This file records open Dependabot advisories that cannot be closed by a
non-breaking version bump, and how each one was triaged. It is updated
whenever an advisory is fixed or re-triaged. Last review: 2026-10-16.

## Fixed by version bump

| Alert | Package | Manifest | Severity | Action |
| --- | --- | --- | --- | --- |
| #4 (GHSA-w5hq-g745-h8pq) | `uuid` < 11.1.1 | `snap/package-lock.json` | medium | `snap/package.json` `overrides` pins `uuid` to `^11.1.1` (resolves 11.1.1). Both consumers (`@metamask/utils` 11.x and `@metamask/analytics-controller` 1.x) only call `uuid.v4()`, whose API is unchanged in 11.x. The vulnerable code path (v3/v5/v6 with a caller-supplied buffer) was never used. `uuid` is not part of the Snap bundle (`snap/dist/bundle.js`). |
| #1 (GHSA-6w46-j5rx-g56g) | `pytest` < 9.0.3 | `telegram-game/requirements-dev.txt` | medium | Already fixed on `main`: the file pins `pytest==9.0.3` (bump merged in #959). The alert should close on the next dependency-graph refresh. |

## No patched release available (accepted risk, documented)

| Alert | Package | Manifest | Severity | Why it is not exploitable here |
| --- | --- | --- | --- | --- |
| #2 (GHSA-848j-6mx2-7j84) | `elliptic` <= 6.6.1 | `snap/package-lock.json` | low | Upstream has no patched version. It is a transitive **development** dependency of `@metamask/snaps-cli` (browserify crypto polyfills and `@ethersproject/signing-key`). The Snap signs with `@noble/curves`; `elliptic` does not appear in `snap/dist/bundle.js`, and nothing in this repository signs with it. |
| #6 (GHSA-hp3w-g68c-fv3c) | `sprintf-js` <= 1.1.3 | `snap/package-lock.json` | medium | Upstream has no patched version. It is a transitive **development** dependency (`ts-jest` -> `babel-plugin-istanbul` -> `js-yaml@3` -> `argparse@1`) used only while running tests against repository-controlled inputs. It does not appear in `snap/dist/bundle.js`. |

Re-check these entries when upstream publishes a fix or when `@metamask/snaps-cli`
or `ts-jest` drop the dependency; replace the note with a bump at that point.
