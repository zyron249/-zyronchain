# L1 test reliability boundary

The canonical L1 test runner executes every compiled `*.test.js` file and applies a 10-minute per-test timeout on Node 22/24. The timeout is deliberately fail-closed: a hung regression must fail with a concrete test result before GitHub-hosted runners reach their six-hour job ceiling.

This timeout does not skip or filter security, consensus, finality, recovery, mining, custody, RPC, or P2P tests. It is a CI reliability control only and is not evidence of public-testnet, mainnet, mining, or deployment readiness.

If a legitimate regression needs more than ten minutes, the test should be decomposed or moved to a dedicated bounded evidence workflow rather than weakening the canonical timeout.

The `local-devnet` CI job remains known-flaky on some hosts during view-change recovery after quorum loss. Interactive `npm run devnet` does not exercise that path.

Same-inode State-v2 cache mutation tests must change file size. Same-length writes can keep `size+mtimeMs+ctimeMs` identical on coarse-timestamp filesystems and produce a false pass.