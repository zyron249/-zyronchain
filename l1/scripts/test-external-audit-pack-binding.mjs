import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'l1/scripts/build-external-audit-pack.mjs');
const git = (cwd, args, input) => execFileSync('git', args, { cwd, input,
  encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const source = git(root, ['rev-parse', 'HEAD']);
const parent = await realpath(tmpdir());
const directory = await mkdtemp(join(parent, 'zyron-audit-binding-'));
const repo = join(directory, 'repo.git');
git(root, ['clone', '--bare', '--shared', '--quiet', root, repo]);
let sequence = 0;
function run(commit = source, scope = 'docs/l1-audit-scope.json') {
  const output = join(directory, `manifest-${sequence++}.json`);
  const result = spawnSync(process.execPath, [script, '--scope', scope, '--commit-sha', commit, '--out', output],
    { cwd: repo, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.ifError(result.error);
  return { ...result, output };
}
try {
  await test('audit manifest uses exact committed bytes despite substituted worktree inputs', async () => {
    await mkdir(join(repo, 'docs'));
    await writeFile(join(repo, 'docs/l1-audit-scope.json'), '{"substituted":true}');
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const bytes = await readFile(first.output, 'utf8');
    const result = JSON.parse(bytes);
    assert.equal(result.commitSha, source);
    assert.equal(result.inputSource, 'immutable-git-blobs');
    assert.equal(result.status, 'prepared-not-independently-audited');
    const expected = execFileSync('git', ['show', `${source}:l1/src/block.ts`], { cwd: repo, windowsHide: true });
    const block = result.files.find(file => file.path === 'l1/src/block.ts');
    assert.equal(block.sha256, createHash('sha256').update(expected).digest('hex'));
    assert.equal(block.bytes, expected.length);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(await readFile(second.output, 'utf8'), bytes);
  });
  await test('audit manifest rejects nonexistent commit labels and blob object identities', () => {
    const absent = run('0'.repeat(40));
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /available exact Git commit/);
    const blob = git(repo, ['rev-parse', `${source}:l1/src/block.ts`]);
    const wrongType = run(blob);
    assert.notEqual(wrongType.status, 0);
    assert.match(wrongType.stderr, /available exact Git commit/);
  });
  await test('audit manifest rejects unsafe scope paths', () => {
    const result = run(source, '../docs/l1-audit-scope.json');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe audit path/);
  });
  await test('audit manifest rejects a committed symlink instead of following it', () => {
    git(repo, ['read-tree', source]);
    const blob = git(repo, ['hash-object', '-w', '--stdin'], 'outside-secret\n');
    git(repo, ['update-index', '--add', '--cacheinfo', `120000,${blob},docs/l1-audit-scope.json`]);
    const tree = git(repo, ['write-tree']);
    const commit = git(repo, ['-c', 'user.name=Codex', '-c', 'user.email=codex@localhost',
      'commit-tree', tree, '-p', source, '-m', 'Symlink fixture only']);
    const result = run(commit);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a committed regular file/);
    assert.equal(result.stderr.includes('outside-secret'), false);
  });
} finally {
  // Only the exact freshly-created fixture directory is removed.
  assert.equal(dirname(resolve(directory)), parent);
  assert.ok(directory.startsWith(join(parent, 'zyron-audit-binding-')));
  await rm(directory, { recursive: true, force: true });
}
