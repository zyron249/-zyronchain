# Push / PR instructions (Gate 0)

This box does not have `gh` authentication. If `git push` fails, run the following from a machine with credentials (or after providing a GitHub token to the agent environment).

## Gate 0 branch

```bash
cd /path/to/-zyronchain
git checkout readiness/gate0-baseline
git push -u origin readiness/gate0-baseline

gh pr create --draft --base main --head readiness/gate0-baseline \
  --title "docs(readiness): Gate 0 baseline ledger + 50M supply invariant" \
  --body-file docs/readiness/GATE0_PR_BODY.md
```

Do **not** merge without human approval. This PR is documentation + supply invariant tests only.


## Gate 1 branches (draft — do not merge)

```bash
# Rebased #904 (self-contained stack including #903 commits + Gate 0/1 additions)
git push -u origin cursor/round-view-change-liveness-068e

# Rebased #903 companion (scaffold only)
git push -u origin cursor/public-testnet-identity-scaffold-70eb

# Gate 0 baseline (if not already pushed)
git push -u origin readiness/gate0-baseline
```

If force-with-lease is required after rebase (history rewritten):

```bash
git push --force-with-lease origin cursor/round-view-change-liveness-068e
git push --force-with-lease origin cursor/public-testnet-identity-scaffold-70eb
```

Update PR bodies to note: rebased onto main `8794b4e`; keep **draft**; do not auto-merge; claim only internal engineering qualification.
