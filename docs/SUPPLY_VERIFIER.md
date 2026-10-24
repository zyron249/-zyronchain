# Fixed-supply verifier

`tools/supply-verifier/` is a read-only command-line tool that lets anyone check, without trusting a single node, that ZyronChain's supply is exactly **50,000,000 ZYN** (`MAX_SUPPLY_ATOMS` in `l1/src/types.ts`). It sends no transactions and changes no consensus rule.

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
   - `pending`: always 0, because the protocol has no escrow or pending-balance state. Value moves only in final blocks, and mempool contents are not supply.

   It requires `balances + pending + burned == genesis supply == 50,000,000 ZYN` and `locked <= balances`.

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
- `--json` prints the full report: buckets, tip hash, endpoint tips and locked accounts.

## Reproducible build

The release artifact is `tools/supply-verifier/dist/zyron-supply-verifier.tar`, which is not committed. It holds the verifier sources, the compiled l1 modules it imports and the l1 manifest and lockfile.

```bash
node tools/supply-verifier/build.mjs --clean-l1   # npm ci (pinned by l1/package-lock.json) + fresh tsc build + pack
node tools/supply-verifier/hash.mjs               # sha256 of the artifact
```

The archive is plain ustar with sorted paths, mtime 0, uid and gid 0, mode 0644 and no owner names, so the same commit with the same Node major version and the locked TypeScript gives a byte-identical file. `dist/MANIFEST.sha256` lists a hash per file. `test/build.test.mjs` checks that two builds hash the same. To run the extracted artifact, run `npm ci` in its `l1/` directory.

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

The tests use a deterministic fixture chain with test keys and fake endpoints. They cover the happy path at exactly 50M, a header mismatch between endpoints, a wrong genesis hash, a single endpoint, an unreachable or failing endpoint, missing blocks, a tampered block, a genesis supply other than 50M, and tampered balance or burn totals. The failing-first log is in `tools/supply-verifier/evidence/failing-first.log`.

## Known limits

- **Trust in the l1 code.** Replay trusts the l1 consensus code at the verified commit. The tool doesn't independently reimplement it.
- **Endpoint independence.** It can't tell whether two endpoints are operated independently.
- **Full replay on every run.** There's no checkpoint, so a run takes time proportional to chain length.
- **Runtime dependencies.** The artifact covers the tool and the compiled l1 modules. The third-party packages come from `npm ci` using the pinned lockfile and are not inside the tar.
