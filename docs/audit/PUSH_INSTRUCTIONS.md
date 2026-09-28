# Push instructions (audit branch)

Local branch: `audit/security-20260928`  
Remote push may fail without a `gh`/git token in this environment.

```bash
cd "/workspace/zyron-l1/-zyronchain"
git status
git log --oneline -5
git push -u origin audit/security-20260928
# If using GitHub CLI after auth:
# gh auth login
# git push -u origin audit/security-20260928
```

Do **not** force-push. Do **not** merge to `main` from this audit branch without human review.
