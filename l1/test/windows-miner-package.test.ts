import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = resolve(process.cwd(), '..', '.github', 'workflows', 'miner-release-candidate.yml');

describe('Windows end-user miner package contract', () => {
  it('keeps Windows materialization/publication fail closed while allowing only local inactive integrity/checksum-bound POSIX candidates', async () => {
    const workflowText = await readFile(workflow, 'utf8');

    assert.match(workflowText, /Prove Windows package entrypoint fails closed before writes/);
    assert.match(workflowText, /if: runner\.os == 'Windows'/);
    assert.match(workflowText, /if node scripts\/package-miner\.mjs >package-miner\.stdout 2>package-miner\.stderr; then/);
    assert.match(workflowText, /Miner packaging requires the audited descriptor-relative POSIX custody path; this platform remains fail-closed\./);
    assert.match(workflowText, /if \[ -e miner-release \]/);

    assert.match(workflowText, /Construct audited POSIX release candidate/);
    assert.match(workflowText, /if: runner\.os != 'Windows'/);
    assert.match(workflowText, /node scripts\/package-miner\.mjs/);
    assert.match(workflowText, /Verify POSIX candidate remains local, inactive, integrity-bound, and checksummed/);
    assert.match(workflowText, /candidate-integrity\.json/);
    assert.match(workflowText, /verifyCandidateIntegrity/);
    assert.match(workflowText, /p\.sourceCommit!==process\.env\.GITHUB_SHA/);
    assert.match(workflowText, /node scripts\/generate-miner-sha256sums\.mjs "\$candidate"/);
    assert.match(workflowText, /test -f "\$candidate\/SHA256SUMS"/);
    assert.match(workflowText, /verifyMinerSha256Sums/);
    assert.match(workflowText, /publicMiningActivated !== false/);
    assert.match(workflowText, /p\.rpcUrl !== null/);
    assert.match(workflowText, /p\.genesisFile !== null/);

    assert.doesNotMatch(workflowText, /Package Windows end-user ZIP/);
    assert.doesNotMatch(workflowText, /actions\/upload-artifact/);
    assert.doesNotMatch(workflowText, /actions\/attest/);
    assert.doesNotMatch(workflowText, /id-token: write/);
    assert.doesNotMatch(workflowText, /contents: write/);
  });
});
