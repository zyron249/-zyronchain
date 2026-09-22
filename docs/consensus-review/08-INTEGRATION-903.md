# Integration with deployment PR #903

PR #903 head is `49b6002e3b13369ac36b0754a8f9f94d69906d6f` on `cursor/public-testnet-identity-scaffold-70eb`. PR #904 is `cursor/round-view-change-liveness-068e` and its merge-base with that commit is that commit. #904 is a descendant. A merge of #903 into #904 is already up to date.

No second integration branch was pushed. A branch with the same tree would be a second pull request containing the same consensus patch. Consensus commits were not added to #903.

## What the combined tree is

The deployment scaffold from #903 (identity, RPC classification, governance candidate, provisioning checks) plus the consensus files in `docs/CONSENSUS_1_1_CHANGELOG.md`.

Checked on that tree, without activating anything:

- Candidate governance `l1/config/public-testnet-governance-input.candidate.json` has `validators: []`, `initialProtocolVersion: 1`, empty bootstrap and RPC origin lists. No validator key was invented.
- New consensus routes are classified as consensus in the public RPC map, so a public listener does not serve them.
- Genesis chain protocol stays 1. Consensus wire on this tree is 1.1.0. That pair is what the mixed-version qualification test finalizes.
- Economics files and flag files are not part of the consensus diff.
- N=3 is not a hardcoded quorum. `validatorQuorumSize(3)` is 3 because `floor(2*3/3)+1 = 3`. N=4 and N=7 tests run the same functions.

## Not done

- No deploy, no DNS, no cloud instance, no flag flip.
- No automatic merge of #904 or #903.
- #904 stays draft. Recommendation to a human: mark ready for review only after CI on the current head is green. Do not undraft from this package alone.
