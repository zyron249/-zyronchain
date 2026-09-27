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
