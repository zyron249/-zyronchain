import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSigningChoices } from './devnet-diagnostics.mjs';

const record = (height, kind = 'attest') => ({ height, round: 0, kind, value: 'ab'.repeat(32) });
async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'zyron-diagnostic-test-'));
  try { await run(directory, join(directory, 'signing-journal.ndjson')); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test('journal diagnostics preserve split choices but never output hashes', () => fixture(async (dir, path) => {
  await writeFile(path, [record(3), record(4, 'skip')].map(JSON.stringify).join('\n') + '\n');
  assert.deepEqual(await readSigningChoices(dir), { status: 'read', choices: [
    { height: 3, round: 0, kind: 'attest' }, { height: 4, round: 0, kind: 'skip' }
  ], omittedRecords: 0, rejectedRecords: 0 });
}));

test('journal diagnostics reject arbitrary fields and malformed records without leaking their content', () => fixture(async (dir, path) => {
  const secret = 'DO_NOT_PRINT_PRIVATE_MATERIAL';
  await writeFile(path, [secret, JSON.stringify({ ...record(1), privateKey: secret }),
    JSON.stringify({ ...record(1), kind: secret }), JSON.stringify({ ...record(1), height: -1 }),
    JSON.stringify({ ...record(1), value: secret }), JSON.stringify(record(2)), '{"height":'].join('\n'));
  const result = await readSigningChoices(dir);
  assert.equal(result.rejectedRecords, 6);
  assert.deepEqual(result.choices, [{ height: 2, round: 0, kind: 'attest' }]);
  assert.equal(JSON.stringify(result).includes(secret), false);
}));

test('journal diagnostics bound both input bytes and output records', () => fixture(async (dir, path) => {
  await writeFile(path, Array.from({ length: 20 }, (_, i) => JSON.stringify(record(i + 1))).join('\n'));
  const result = await readSigningChoices(dir);
  assert.equal(result.choices.length, 12);
  assert.equal(result.choices[0].height, 9);
  assert.equal(result.omittedRecords, 8);
  await writeFile(path, 'x'.repeat(64 * 1024 + 1));
  assert.deepEqual(await readSigningChoices(dir), { status: 'oversized' });
}));

test('journal diagnostics handle absent files and directories without raw errors', () => fixture(async (dir, path) => {
  assert.deepEqual(await readSigningChoices(dir), { status: 'missing' });
  await mkdir(path);
  assert.deepEqual(await readSigningChoices(dir), { status: 'not-regular' });
}));
