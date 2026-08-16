import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const workflow = resolve(process.cwd(), '..', '.github', 'workflows', 'miner-release-candidate.yml');
const packager = resolve(process.cwd(), 'scripts', 'package-windows-miner-zip.mjs');

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
