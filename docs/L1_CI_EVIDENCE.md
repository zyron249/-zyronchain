# Standalone L1 CI security evidence

Status: pre-public-testnet engineering evidence. These artifacts do **not** authorize a public testnet or mainnet launch.

## Purpose

The highest-risk standalone L1 rehearsals emit structured JSON summaries. Standalone L1 CI wraps each successful summary in a common evidence envelope and uploads it as a GitHub Actions artifact retained for 90 days. This makes the tested commit, workflow run, job, runtime and scenario machine-readable instead of relying only on human-readable logs.

The archived scenarios are:

- `mixed-version-upgrade-rollback`
- `disaster-recovery`
- `composite-adversarial-soak`
- `multiprocess-native-recovery`
- `validator-key-rotation`

## Evidence envelope

`l1/scripts/archive-ci-evidence.mjs` accepts only a rehearsal result whose top-level `status` is exactly `ok`. It then writes `evidence.json` with:

- `evidenceVersion`: current schema version (`1`)
- `scenario`: stable scenario identifier
- `repository`: GitHub repository identity
- `commitSha`: exact 40-hex commit tested by the workflow
- `workflow`: workflow name
- `job`: GitHub job identifier
- `runId` and `runAttempt`
- `runtime`: Node.js version, platform and architecture
- `resultSha256`: SHA-256 of the raw successful rehearsal JSON
- `result`: the complete rehearsal result object

The helper fails closed if required GitHub run metadata is absent or malformed, the result is not valid JSON, or the rehearsal did not report `status: "ok"`.

## Artifact integrity

Each security rehearsal job also writes `SHA256SUMS` over `evidence.json`. The pinned `actions/upload-artifact` action uploads both files with `if-no-files-found: error` and a 90-day retention period. Artifact names include the tested commit SHA and workflow run attempt.

The checksum is an integrity check for the downloaded evidence bundle. It is not an external timestamp, transparency log, independent signature or audit attestation.

## Verification

For a downloaded artifact:

```bash
sha256sum -c SHA256SUMS
```

Then inspect `evidence.json` and confirm that `repository`, `commitSha`, `scenario`, `runId`, `runAttempt` and the scenario-specific `result` match the CI run being reviewed.

## Validator-key rotation evidence

The `validator-key-rotation` rehearsal uses deterministic non-production keys. It quorum-authorizes a delayed validator-set replacement, proves the retired key cannot attest once the new set activates, proves the replacement key is immediately eligible to propose/finalize according to the rotation schedule, and proves the activated set survives authenticated snapshot restart. It does not create or certify a production HSM key, signer provider, custody ceremony or cross-host recovery procedure.

## Security boundary

CI evidence proves only the deterministic or loopback-process rehearsal that actually ran on GitHub-hosted infrastructure. It does not prove independent-operator behavior, Internet routing conditions, production HSM custody, physical-disk/power-loss semantics, multi-region disaster recovery, external audit results or public-testnet soak duration. Those remain separate release gates.
