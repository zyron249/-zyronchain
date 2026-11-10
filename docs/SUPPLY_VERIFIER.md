# Fixed-supply verifier

`tools/supply-verifier/` is a read-only command-line tool that lets anyone check, without trusting a single node, that ZyronChain's supply is exactly **50,000,000 ZYN** (`MAX_SUPPLY_ATOMS` in `l1/src/types.ts`). It sends no transactions and changes no consensus rule.

## Trust assumptions

Read these before relying on a result:

- **It trusts the l1 consensus code.** The verifier trusts the l1 consensus code at the verified commit (`l1/dist/src`, built from that commit). It is not an independent second implementation: a consensus bug that the node accepts, the verifier accepts too. Check the commit and the artifact hash.
- **Endpoints are not proven independent.** Two URLs may front the same node or operator, and the tool cannot detect that. The header cross-check only adds assurance when the endpoints are run by different people.

Every report (text and `--json`) repeats these two lines under `trustAssumptions`.

## What it checks

1. **Pinned genesis.** The genesis you supply must hash (with the node's own `ZyronChain` genesis code) to the pinned genesis hash. The default pin is the open-testnet genesis `e0212e574271ef1de78ad148965e3d1a4a04afca3071d3c374d29ae5a6d4a8ad`, the same value as in [OPEN_TESTNET.md](OPEN_TESTNET.md) and `website/verify/session.js`. A test keeps the three in sync. The genesis allocations must add up to exactly 50,000,000 ZYN.
2. **Two or more endpoints.** Every endpoint must report the pinned genesis hash and the same chain ID in `GET /status`. The tool refuses to run with fewer than two distinct endpoints.
3. **Header cross-check.** For every height from 1 to the lowest endpoint tip (or `--to-height`), it fetches the block from every endpoint, recomputes the header hash, and requires all endpoints to agree.
4. **Full replay.** Each block goes through `ZyronChain.acceptBlock` from `l1/dist/src`, the same validation a node runs: header hash, proposer and quorum signatures, transaction signatures and nonces, allocation locks, and the state root.
5. **Supply reconciliation in BigInt atoms**, from the replayed state:
   - `balances`: the sum of every account balance, split into
     - `locked`: founder vesting, the permanent-liquidity reserve and the unreleased public distribution at the tip timestamp
     - `spendable`: balances minus locked
   - `burned`: the burned share of every transfer fee (the whole fee, or under `fixed-fee-v1` the fee minus the producer's half)
   - `pending`: always 0, because the protocol has no escrow or pending-balance state. Value moves only in final blocks, and mempool contents are not supply. When reversible-transfer escrow (feature 1) lands, `pending` must be read from the replayed escrow state; a guard test fails if the ledger snapshot gains a pending or escrow field while the verifier still hardcodes 0.

   It requires `balances + pending + burned == genesis supply == 50,000,000 ZYN` and `locked <= balances`.

**Tip drift warning.** If endpoint tips differ by more than `--max-tip-drift` blocks (default 3), the tool prints `WARNING:` and adds it to `warnings` in the report, but does not fail. It still verifies up to the lowest tip.

**Response size cap.** Response bodies are streamed with a running 32 MiB cap. The read is aborted as soon as the cap is passed, and the run fails closed.

Any failure, including an unreachable endpoint, an HTTP error, a missing block, a hash disagreement, a rejected block, or a supply that does not reconcile, prints `FAIL: <reason>` and exits with code 1. A usage error exits with 2, and success exits with 0.

## Usage

```bash
cd l1 && npm ci && npm run build && cd ..
node tools/supply-verifier/cli.mjs \
  --genesis https://zyron-open-testnet.onrender.com/genesis \
  --endpoint https://zyron-open-testnet.onrender.com/peer \
  --endpoint http://<your-follower-node>:<port>
```

- `--endpoint` takes a node RPC base that serves `GET /status` and `GET /blocks?from=&limit=`. That's a node's own RPC or the open-testnet gateway's read-only `/peer` surface. Use endpoints run by different operators. Two URLs that front the same node are not independent, and the tool cannot detect that.
- `--genesis` takes a file or URL holding either a bare genesis config or a `GET /genesis` body. Its source doesn't matter, because its hash must match the pin.
- `--expected-genesis-hash` overrides the pin, for another network, and prints a warning.
- `--max-tip-drift <n>` sets the tip-drift warning threshold in blocks (default 3).
- `--json` prints the full report: buckets, tip hash, endpoint tips and locked accounts.

## Reproducible build

The release artifact is `tools/supply-verifier/dist/zyron-supply-verifier.tar`, which is not committed. It holds the verifier sources, the compiled l1 modules it imports and the l1 manifest and lockfile.

```bash
node tools/supply-verifier/build.mjs --clean-l1   # npm ci (pinned by l1/package-lock.json) + fresh tsc build + pack
node tools/supply-verifier/hash.mjs               # sha256 of the artifact
```

**Node version.** Builds use Node `22.19.0`, pinned in `tools/supply-verifier/.nvmrc` (`engines` in `package.json` requires Node 22). Use exactly that version for a published hash: `npm`, `tsc` output and the lockfile install can differ across Node versions.

**CI check.** `.github/workflows/supply-verifier-reproducible.yml` runs on GitHub-hosted runners with the `.nvmrc` Node version. It builds from two fresh clones of the same commit and fails unless both tar sha256 values match. If `tools/supply-verifier/EXPECTED_SHA256` is ever committed, it also checks the hash against that file. No such file exists yet.

The archive is plain ustar with sorted paths, mtime 0, uid and gid 0, mode 0644 and no owner names, so the same commit with the same Node major version and the locked TypeScript gives a byte-identical file. `dist/MANIFEST.sha256` lists a hash per file. `test/build.test.mjs` checks that two builds hash the same. To run the extracted artifact, run `npm ci` in its `l1/` directory.

### Pin guard

`.github/workflows/supply-verifier-pin-guard.yml` adds a check next to the reproducible build and does not replace it. It runs on `pull_request_target` for PRs into `main`, including label changes. GitHub runs the workflow file and its checker, `.github/scripts/verify-supply-verifier-pin-guard.mjs`, as they are on `main`, so a PR can't edit the checker that judges it. The job has read-only `contents` permission, uses no secrets, and doesn't persist credentials. It installs `main`'s TypeScript from `main`'s `l1/package-lock.json` with `npm ci --ignore-scripts` before it fetches any PR data. It then reads the PR head as git data only. Nothing from the PR is checked out, installed, or executed.

Against the merge base with `main`, the checker:

1. Requires `EXPECTED_SHA256` to exist and be well-formed.
2. Rebuilds the tar from the PR's files with `main`'s `l1/tsconfig.json`, TypeScript, `build.mjs`, and `hash.mjs`, whenever the pin or a hashed input changed. The result must equal the PR's pin, which also catches an input change without a pin update. It prints the per-file `MANIFEST.sha256` diff between the merge base and the head, and writes it to the job summary.
3. Fails a pin move when no hashed input changed.
4. Requires the label `patron-approved-pin` when the pin changes, or when one of these files changes: `l1/src/tokenomics.ts`, `l1/src/supply-report.ts`, `l1/src/allocation-locks.ts`, `l1/src/miner-genesis.ts`, `l1/src/founder-vesting.ts`, `l1/genesis-message.json`, `docs/fixed-supply-launch-plan.json`, `l1/scripts/validate-fixed-supply-genesis.mjs`, `l1/scripts/verify-genesis-message.mjs`, `l1/scripts/verify-trading-activation.mjs`, `l1/src/types.ts`, `l1/src/public-distribution-release.ts`, `tools/supply-verifier/src/**`, or `tools/supply-verifier/*.mjs`. The two `l1/scripts/verify-*.mjs` scripts are outside the tar, so the pin doesn't move when they change. `l1/src/types.ts` (`MAX_SUPPLY_ATOMS`) and `l1/src/public-distribution-release.ts` are in the tar and are listed as a second line of defense. A test checks that every entry exists.
5. Checks label timing when the label is required. The check passes only on a `labeled` event for `patron-approved-pin` itself, and only when the head in the event is still the PR head that the run fetched. That means the approval came after the last push. A `synchronize`, `opened`, `reopened` or `unlabeled` event fails, and so does a `labeled` event for any other label or a re-run of an older `labeled` run after a push. The error tells the reviewer to remove the label and add it again on the current head.

The label is only a second gate. Checks 1 to 3 fail even when the label is present and freshly applied.

How label timing shows up in branch protection: a required check must have a successful, skipped or neutral result on the PR's head SHA, and only the latest run of a check name on that SHA counts. A push creates a new head SHA, and the `synchronize` run for it fails, so the check stays red until the label is re-applied. A later event on the same SHA, such as another label added or removed, starts a new run that fails and replaces the green one. A run cancelled by the `concurrency` group isn't a success. None of this needs more than `contents: read`. It still has to be confirmed on this repository once the workflow is on `main`, because no `pull_request_target` workflow runs here yet. Trade-off: after any label change on an approved head, someone has to add the label again.

Toolchain rules (decided by Patron):

- The toolchain install uses `main`'s `l1/package-lock.json` only. It never falls back to the PR's lockfile or `package.json`.
- The guard fails closed, even with the label, when a PR changes the TypeScript entries in `l1/package-lock.json`, changes `l1/tsconfig.json`, or has an `l1/src` that doesn't compile against `main`'s dependencies.
- Such a toolchain PR lands on its own, with Security's independent rebuild.

Limits:

- The label is advisory. Every bot acts through the same `zyron249` account, so any of them can add it. Label timing proves when the label was added, not who added it.
- The guard blocks a merge only once branch protection makes it a required check, and that is the repository owner's decision.
- Security's independent rebuild (CONTRIBUTING.md) stays mandatory.

`.github/workflows/supply-verifier-pin-guard-custody-policy.yml` checks the workflow in three ways, and all three must pass:

- It pins the exact lines.
- It runs a static lint.
- It parses the file with a strict YAML-subset parser. The parser has no dependencies and refuses duplicate keys, anchors, tags, flow mappings, folded or chomped block scalars, escapes and non-ASCII characters. The parsed file is then checked against a structural allowlist:
  - the top-level keys, with nothing after `jobs:`;
  - exactly one job, with only `runs-on`, `timeout-minutes` and `steps` (no `container`, `services`, `defaults`, job `env` or `if`);
  - exactly four steps, each with exactly its keys;
  - step `env` limited to `PR_NUMBER` and `PR_HEAD_SHA`, with injection names such as `BASH_ENV`, `NODE_OPTIONS`, `LD_*` and `GIT_*` refused by name;
  - every `run:` line checked against a command allowlist.

The custody policy also runs the mutation tests, including every bypass from Security's #1216 proof-of-concept files.

### Publishing hashes

No hashes are published yet. For a release:

1. Tag the commit.
2. Two maintainers each run the build commands above, on separate machines, from a clean checkout of the tag.
3. If the two `hash.mjs` outputs match, post that hash, the tag, the Node version and `MANIFEST.sha256` in the GitHub release notes, and add a row to the table below in a follow-up PR.
4. If they don't match, nothing is published until the difference is explained.

| Tag | Node | sha256 of zyron-supply-verifier.tar |
|-----|------|-------------------------------------|
| (none yet) | | |

## Tests

```bash
node --test tools/supply-verifier/test/verifier.test.mjs tools/supply-verifier/test/build.test.mjs
```

The tests use a deterministic fixture chain with test keys and fake endpoints. They cover the happy path at exactly 50M, a header mismatch between endpoints, a wrong genesis hash, a single endpoint, an unreachable or failing endpoint, missing blocks, a tampered block, a genesis supply other than 50M, and tampered balance or burn totals, tip drift warnings, an oversized streamed response, the trust statements, and the pending/escrow guard. The failing-first logs are in `tools/supply-verifier/evidence/`.

## Known limits

- **Trust in the l1 code.** Replay trusts the l1 consensus code at the verified commit. It is not an independent second implementation.
- **Endpoint independence.** Endpoints are not proven independent; the tool can't tell whether two endpoints are operated independently.
- **Full replay on every run.** There's no checkpoint, so a run takes time proportional to chain length.
- **Runtime dependencies.** The artifact covers the tool and the compiled l1 modules. The third-party packages come from `npm ci` using the pinned lockfile and are not inside the tar.
