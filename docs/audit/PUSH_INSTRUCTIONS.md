# Push instructions (audit branch)

Local branch: `audit/security-20260928`  
Current tip: `a1b534914c1fdd0dce8ade54820cbc00d24a0eb1`  
Code-fix commit: `fcc27ee0d3e83c16af80bf141d6d3e7eda68c0d8`  

`git push` failed here without credentials (`could not read Username for 'https://github.com'`).

```bash
cd "/workspace/zyron-l1/-zyronchain"
git checkout audit/security-20260928
git status
git log --oneline -5
# authenticate, then:
git push -u origin audit/security-20260928
```

Do **not** force-push. Do **not** merge to `main` without human review of the audit findings and patches.
