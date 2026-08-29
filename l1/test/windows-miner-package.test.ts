import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = resolve(process.cwd(), '..', '.github', 'workflows', 'miner-release-candidate.yml');

describe('Windows end-user miner package contract', () => {
  it('keeps package materialization and publication fail closed while custody is quarantined', async () => {
    const workflowText = await readFile(workflow, 'utf8');
    assert.match(workflowText, /Prove release-candidate materialization is quarantined before filesystem writes/);
    assert.match(workflowText, /node scripts\/test-miner-packaging-quarantine\.mjs/);
    assert.match(workflowText, /Assert no release candidate was materialized/);
    assert.match(workflowText, /if \[ -e miner-release \]/);
    assert.doesNotMatch(workflowText, /Package Windows end-user ZIP/);
    assert.doesNotMatch(workflowText, /actions\/upload-artifact/);
    assert.doesNotMatch(workflowText, /actions\/attest/);
  });
});
