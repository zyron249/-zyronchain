import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = new URL('../../.github/workflows/miner-release-candidate.yml', import.meta.url);
const packager = new URL('../scripts/package-windows-miner-zip.mjs', import.meta.url);

describe('Windows end-user miner package contract', () => {
  it('keeps publication and public mining fail closed while producing a ZIP candidate', async () => {
    const [workflowText, packagerText] = await Promise.all([
      readFile(workflow, 'utf8'),
      readFile(packager, 'utf8')
    ]);
    assert.match(workflowText, /Package Windows end-user ZIP/);
    assert.match(workflowText, /ZyronMiner-windows-\*\.zip/);
    assert.match(workflowText, /publicMiningActivated: false/);
    assert.match(workflowText, /publicationAllowed: false/);
    assert.match(packagerText, /Compress-Archive/);
    assert.match(packagerText, /Windows miner ZIP packaging must run on Windows/);
  });
});
