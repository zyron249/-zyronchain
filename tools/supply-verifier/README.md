# Supply verifier

Read-only tool that replays ZyronChain from the pinned genesis and reconciles the supply to exactly 50,000,000 ZYN. See [docs/SUPPLY_VERIFIER.md](../../docs/SUPPLY_VERIFIER.md).

Trust assumptions: the verifier trusts the l1 consensus code at the verified commit and is not an independent second implementation. Endpoints are not proven independent; two URLs may front the same node.

Build with the Node version in [.nvmrc](.nvmrc).

## Pinned tarball hash

`EXPECTED_SHA256` holds the SHA-256 of the reproducible `zyron-supply-verifier.tar`
built from the current tree. The `Supply Verifier Reproducible Build` workflow builds
the tar twice from fresh clones with the Node version in `.nvmrc`, checks the two
builds match, and fails if the hash differs from `EXPECTED_SHA256`.

The tar bundles `l1/src`, so any change there (not only under `tools/supply-verifier`)
can change the hash.

To update the pin intentionally:

1. Use Node from `tools/supply-verifier/.nvmrc` (`node --version` must match).
2. From a clean checkout of your branch, merge the latest `origin/main` into your branch first (a normal
   `git merge`, never a rebase), because on pull requests CI hashes the test merge with
   `main`, not your PR head. Then run, at the repository root:

   ```sh
   npm run pin-hash
   ```

   This runs `tools/supply-verifier/pin-hash.mjs`, the same build steps CI uses, and
   rewrites `EXPECTED_SHA256`. It warns if your Node version differs from `.nvmrc`.

3. Commit `EXPECTED_SHA256` in the same PR as the change that caused it, and say
   in the PR why the verifier output changed.
4. A pin bump needs an independent hash confirmation in review: a reviewer reruns
   `npm run pin-hash` on the same merged tree and confirms the same hash.
5. Confirm the workflow passes on the PR; its log prints the hash it built.

Never update the pin to silence a mismatch you cannot explain: an unexplained change
means the build is not reproducible or the inputs changed unexpectedly.

`EXPECTED_SHA256` must hold exactly 64 lowercase hex characters, optionally followed by
whitespace and a filename; CI fails with a clear error if it is malformed.
