#!/usr/bin/env node
// Fixture tests for .github/scripts/verify-supply-verifier-pin-guard.mjs, the
// checker that .github/workflows/supply-verifier-pin-guard.yml runs from main.
// Each case builds a throwaway git repository in a temp directory, writes a
// synthetic pull_request event payload and runs the checker CLI as the
// workflow does, then asserts the exit status and the reason it prints.
// Offline: no network and no secrets. The rebuild uses a stand-in TypeScript
// (a tiny emitter that copies sources) so the cases need no node_modules; the
// expected "correct" hash is assembled independently here, with the repo's
// real build.mjs and hash.mjs. With PIN_GUARD_TOOLCHAIN=<l1/node_modules from
// main's lockfile>, one more case rebuilds the real repository with the real
// TypeScript and requires the committed pin to match.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const CHECKER = join(here, 'verify-supply-verifier-pin-guard.mjs');
const guard = await import('./verify-supply-verifier-pin-guard.mjs');
const { APPROVAL_LABEL, PIN_PATH, PIN_RE, SUPPLY_SENSITIVE_PATHS, evaluatePinGuard, isHashInput, isSupplySensitive, manifestDiff } = guard;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
delete GIT_ENV.GITHUB_STEP_SUMMARY;
const WORK = mkdtempSync(join(tmpdir(), 'pin-guard-tests-'));
// If anything from a PR were executed, it would create this file.
const MARKER = join(WORK, 'PR-CODE-WAS-EXECUTED');

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`ok - ${name}`); }
  catch (error) { failures.push(name); console.log(`not ok - ${name}\n  ${String(error?.stack ?? error).split('\n').join('\n  ')}`); }
}
function git(cwd, ...args) { return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim(); }
function write(dir, rel, data) { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), data); }

// Stand-in TypeScript: emits <rootDir>/src/**/*.ts to <outDir>/src/**/*.js
// verbatim with a banner, and fails like tsc on a source containing TYPE_ERROR.
const TOOLCHAIN = join(WORK, 'toolchain');
write(TOOLCHAIN, 'typescript/bin/tsc', `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const a = process.argv.slice(2); const out = a[a.indexOf('--outDir') + 1]; const root = a[a.indexOf('--rootDir') + 1];
let bad = false;
(function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) {
  const src = fs.readFileSync(p, 'utf8'); if (src.includes('TYPE_ERROR')) { console.log(p + ': error TS2322: TYPE_ERROR'); bad = true; }
  const o = path.join(out, path.relative(root, p)).replace(/\\.ts$/, '.js'); fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, '// emitted\\n' + src);
} } })(path.join(root, 'src'));
process.exit(bad ? 2 : 0);
`);

const REAL_LOCK = readFileSync(join(repoRoot, 'l1/package-lock.json'), 'utf8');
const REAL_TSCONFIG = readFileSync(join(repoRoot, 'l1/tsconfig.json'), 'utf8');
const markerJs = `require('node:fs').writeFileSync(${JSON.stringify(MARKER)}, 'x');\n`;
const markerMjs = `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(MARKER)}, 'x');\n`;
function baseFiles() {
  return {
    'README.md': 'fixture\n',
    'docs/fixed-supply-launch-plan.json': '{"total":50000000}\n',
    'l1/package.json': '{"name":"l1","scripts":{"preinstall":"node -e x","build":"tsc --outDir dist"}}\n',
    'l1/package-lock.json': REAL_LOCK,
    'l1/tsconfig.json': REAL_TSCONFIG,
    'l1/src/chain.ts': 'export const x: number = 1;\n',
    'l1/src/tokenomics.ts': 'export const TOTAL = 50_000_000;\n',
    'tools/supply-verifier/cli.mjs': 'console.log(1);\n',
    'tools/supply-verifier/package.json': '{"name":"sv","scripts":{"preinstall":"node marker.cjs"}}\n',
    'tools/supply-verifier/package-lock.json': '{}\n',
    'tools/supply-verifier/src/verify.mjs': 'export const v = 1;\n',
    // The PR-side build scripts. Main's real ones must be used instead; these
    // would create the marker if anything ran them.
    'tools/supply-verifier/build.mjs': markerMjs,
    'tools/supply-verifier/hash.mjs': markerMjs,
    'tools/supply-verifier/pin-hash.mjs': markerMjs,
    'tools/supply-verifier/marker.cjs': markerJs,
  };
}

/** Correct pin for a file set, assembled independently of the checker. */
function independentPin(files) {
  const dir = mkdtempSync(join(WORK, 'indep-'));
  for (const [rel, data] of Object.entries(files)) if (rel.startsWith('l1/') || rel.startsWith('tools/supply-verifier/')) write(dir, rel, data);
  execFileSync(process.execPath, [join(TOOLCHAIN, 'typescript/bin/tsc'), '--outDir', join(dir, 'l1/dist'), '--rootDir', join(dir, 'l1')]);
  copyFileSync(join(repoRoot, 'tools/supply-verifier/build.mjs'), join(dir, 'tools/supply-verifier/build.mjs'));
  copyFileSync(join(repoRoot, 'tools/supply-verifier/hash.mjs'), join(dir, 'tools/supply-verifier/hash.mjs'));
  execFileSync(process.execPath, [join(dir, 'tools/supply-verifier/build.mjs')], { cwd: dir, stdio: 'ignore' });
  const line = execFileSync(process.execPath, [join(dir, 'tools/supply-verifier/hash.mjs')], { cwd: dir, encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return line;
}
const WRONG = `${'c'.repeat(64)}  zyron-supply-verifier.tar\n`;

/**
 * Commits baseFiles() (with its correct pin unless basePin is given) as main,
 * then a PR commit with edit(files) applied. pin: 'correct' recomputes the pin
 * for the edited files, 'keep' leaves it, null deletes it, a string writes it.
 */
function fixture(edit, { pin = 'keep', basePin = 'correct', after = null } = {}) {
  const dir = mkdtempSync(join(WORK, 'repo-'));
  git(dir, 'init', '--quiet', '--initial-branch=main');
  const files = baseFiles();
  if (basePin === 'correct') files[PIN_PATH] = independentPin(files);
  else if (basePin !== null) files[PIN_PATH] = basePin;
  for (const [rel, data] of Object.entries(files)) write(dir, rel, data);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'base');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'checkout', '--quiet', '-b', 'pr');
  edit(files);
  if (pin === 'correct') files[PIN_PATH] = independentPin(files);
  else if (pin === null) delete files[PIN_PATH];
  else if (pin !== 'keep') files[PIN_PATH] = pin;
  for (const rel of git(dir, 'ls-files').split('\n').filter(Boolean)) rmSync(join(dir, rel), { recursive: true, force: true });
  for (const [rel, data] of Object.entries(files)) write(dir, rel, data);
  if (after) after(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '--allow-empty', '-m', 'pr');
  return { dir, head: git(dir, 'rev-parse', 'HEAD') };
}

function run(dir, head, labels, { eventHead = head, args = null, rawEvent = null, toolchain = TOOLCHAIN } = {}) {
  const eventPath = join(WORK, `event-${process.hrtime.bigint()}.json`);
  writeFileSync(eventPath, rawEvent ?? JSON.stringify({ pull_request: { number: 7, head: { sha: eventHead }, labels: labels.map((name) => ({ name })) } }));
  const argv = args ?? ['--merge-base', 'origin/main', '--head', head, '--event', eventPath, '--toolchain', toolchain, '--scratch', join(WORK, `scratch-${process.hrtime.bigint()}`)];
  const r = spawnSync(process.execPath, [CHECKER, ...argv], { cwd: dir, env: GIT_ENV, encoding: 'utf8' });
  rmSync(eventPath, { force: true });
  assert.ok(!existsSync(MARKER), 'PR content was executed');
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const expectPass = (r) => { assert.equal(r.status, 0, `expected exit 0, got ${r.status}:\n${r.out}`); assert.match(r.out, /pin guard: ok/); };
const expectFail = (r, ...why) => { assert.equal(r.status, 1, `expected exit 1, got ${r.status}:\n${r.out}`); assert.match(r.out, /pin guard: FAILED/); for (const w of why) assert.match(r.out, w); };
const LABEL_MISSING = new RegExp(`label "${APPROVAL_LABEL}" is missing`);
const MISMATCH = /rebuilt with main's scripts, the tar sha256 is [0-9a-f]{64}, but/;
const L = [APPROVAL_LABEL];
const src2 = (f) => { f['l1/src/chain.ts'] = 'export const x: number = 2;\n'; };
const lockBump = (f) => { const lock = JSON.parse(f['l1/package-lock.json']); const key = Object.keys(lock.packages).find((k) => k.startsWith('node_modules/') && !k.includes('typescript')); lock.packages[key].version = '9.9.9-fixture'; f['l1/package-lock.json'] = `${JSON.stringify(lock, null, 2)}\n`; };

const cases = [
  // name, edit, options, labels, expectation
  ['pin unchanged, docs only, no label: pass (no rebuild needed)', (f) => { f['README.md'] = 'docs\n'; }, {}, [], (r) => { expectPass(r); assert.match(r.out, /rebuild: not needed/); }],
  ['pin changed with the correct hash and the label: pass', src2, { pin: 'correct' }, L, (r) => { expectPass(r); assert.match(r.out, /matches tools\/supply-verifier\/EXPECTED_SHA256/); assert.match(r.out, /\| `l1\/dist\/src\/chain\.js` \|/); }],
  ['#1206 shape (l1 lockfile only), correct hash, label: pass, diff shows only the lockfile', lockBump, { pin: 'correct' }, L, (r) => { expectPass(r); assert.match(r.out, /\d+ identical, 1 differ/); assert.match(r.out, /\| `l1\/package-lock\.json` \|/); }],
  ['pin changed with the correct hash but no label: fail', src2, { pin: 'correct' }, [], (r) => expectFail(r, LABEL_MISSING)],
  ['pin changed with the correct hash, only look-alike labels: fail', src2, { pin: 'correct' }, ['Patron-Approved-Pin', 'patron-approved', 'supply-pin-approved'], (r) => expectFail(r, LABEL_MISSING)],
  ['pin changed with a wrong hash and the label: fail', src2, { pin: WRONG }, L, (r) => expectFail(r, MISMATCH, /does not override this/)],
  ['pin changed with a wrong hash and no label: fail', src2, { pin: WRONG }, [], (r) => expectFail(r, MISMATCH, LABEL_MISSING)],
  ['pin moved with no hashed input changed, with the label: fail', (f) => { f['README.md'] = 'x\n'; }, { pin: WRONG }, L, (r) => expectFail(r, /no file that feeds the hashed tar changed/, MISMATCH)],
  ['artifact change without a pin update, no label: fail', src2, {}, [], (r) => expectFail(r, MISMATCH)],
  ['artifact change without a pin update, with the label: fail', src2, {}, L, (r) => expectFail(r, MISMATCH)],
  ['malformed pin (uppercase hex) with the label: fail', src2, { pin: `${'A'.repeat(64)}\n` }, L, (r) => expectFail(r, /malformed/)],
  ['malformed pin (63 hex chars) with the label: fail', src2, { pin: `${'b'.repeat(63)}\n` }, L, (r) => expectFail(r, /malformed/)],
  ['malformed pin (two lines) with the label: fail', src2, { pin: `${WRONG}${WRONG}` }, L, (r) => expectFail(r, /malformed/)],
  ['malformed pin (empty) with the label: fail', src2, { pin: '' }, L, (r) => expectFail(r, /malformed/)],
  ['pin file deleted with the label: fail', () => {}, { pin: null }, L, (r) => expectFail(r, /missing or deleted/)],
  ['pin file deleted without the label: fail', () => {}, { pin: null }, [], (r) => expectFail(r, /missing or deleted/)],
  ['pin file replaced by a directory with the label: fail', (f) => { f[`${PIN_PATH}/x`] = WRONG; }, { pin: null }, L, (r) => expectFail(r, /missing or deleted/)],
  ['supply file in the tar changed (tokenomics.ts), correct pin, no label: fail', (f) => { f['l1/src/tokenomics.ts'] = 'export const TOTAL = 60_000_000;\n'; }, { pin: 'correct' }, [], (r) => expectFail(r, /supply, genesis or allocation files changed \(l1\/src\/tokenomics\.ts\)/)],
  ['supply file in the tar changed (tokenomics.ts), correct pin, label: pass', (f) => { f['l1/src/tokenomics.ts'] = 'export const TOTAL = 60_000_000;\n'; }, { pin: 'correct' }, L, expectPass],
  ['supply file outside the tar changed (launch plan), pin unchanged, no label: fail', (f) => { f['docs/fixed-supply-launch-plan.json'] = '{"total":1}\n'; }, {}, [], (r) => expectFail(r, /fixed-supply-launch-plan\.json/)],
  ['supply file outside the tar changed (launch plan), pin unchanged, label: pass', (f) => { f['docs/fixed-supply-launch-plan.json'] = '{"total":1}\n'; }, {}, L, expectPass],
  ["PR edits the verifier's build scripts, no label: fail (main's scripts are used, PR's never run)", (f) => { f['tools/supply-verifier/build.mjs'] = `${markerMjs}// v2\n`; f['tools/supply-verifier/hash.mjs'] = `${markerMjs}console.log('${'0'.repeat(64)}  zyron-supply-verifier.tar');\n`; }, {}, [], (r) => expectFail(r, /tools\/supply-verifier\/build\.mjs/)],
  ["PR makes its hash.mjs print a chosen hash and pins that hash, label: fail (main's hash.mjs is used)", (f) => { f['tools/supply-verifier/hash.mjs'] = `console.log('${'0'.repeat(64)}  zyron-supply-verifier.tar');\n`; }, { pin: `${'0'.repeat(64)}  zyron-supply-verifier.tar\n` }, L, (r) => expectFail(r, MISMATCH)],
  ['TypeScript toolchain changed in l1/package-lock.json, label: fail closed', (f) => { const lock = JSON.parse(f['l1/package-lock.json']); lock.packages['node_modules/typescript'].version = '7.9.9'; f['l1/package-lock.json'] = `${JSON.stringify(lock, null, 2)}\n`; }, { pin: 'correct' }, L, (r) => expectFail(r, /TypeScript toolchain in l1\/package-lock\.json differs from main's/)],
  ['l1/tsconfig.json changed, label: fail closed', (f) => { f['l1/tsconfig.json'] = REAL_TSCONFIG.replace('"strict": true', '"strict": false'); }, { pin: 'correct' }, L, (r) => expectFail(r, /l1\/tsconfig\.json differs from main's/)],
  ["l1/src does not compile with main's toolchain, label: fail closed", (f) => { f['l1/src/chain.ts'] = 'TYPE_ERROR\n'; }, { pin: WRONG }, L, (r) => expectFail(r, /could not compile/)],
  ['symlink inside l1/src, label: fail closed', () => {}, { pin: 'keep', after: (d) => symlinkSync('/etc/hostname', join(d, 'l1/src/link.ts')) }, L, (r) => expectFail(r, /not a regular file/)],
  ['pin added where main had none, correct hash, label: pass', () => {}, { basePin: null, pin: 'correct' }, L, expectPass],
  ['pin added where main had none, correct hash, no label: fail', () => {}, { basePin: null, pin: 'correct' }, [], (r) => expectFail(r, LABEL_MISSING)],
];
for (const [name, edit, options, labels, expectation] of cases) {
  await test(name, () => { const { dir, head } = fixture(edit, options); expectation(run(dir, head, labels)); });
}

// Fail closed.
const simple = fixture((f) => { f['README.md'] = 'x\n'; });
const changed = fixture(src2, { pin: 'correct' });
await test('fail closed: event head SHA differs from --head', () => expectFail(run(simple.dir, simple.head, [], { eventHead: 'f'.repeat(40) }), /does not match/));
await test('fail closed: unknown head commit', () => expectFail(run(simple.dir, 'e'.repeat(40), [])));
await test('fail closed: event payload is not JSON', () => expectFail(run(simple.dir, simple.head, [], { rawEvent: '{not json' })));
await test('fail closed: event payload without pull_request.labels', () => expectFail(run(simple.dir, simple.head, [], { rawEvent: JSON.stringify({ pull_request: { head: { sha: simple.head } } }) }), /labels/));
await test('fail closed: missing arguments', () => expectFail(run(simple.dir, simple.head, [], { args: ['--head', simple.head] }), /usage/));
await test('fail closed: option-looking revision is refused', () => expectFail(run(simple.dir, simple.head, [], { args: ['--merge-base', '--output=/tmp/x', '--head', simple.head, '--event', '/dev/null', '--toolchain', TOOLCHAIN, '--scratch', join(WORK, 's')] })));
await test("fail closed: main's TypeScript not installed", () => expectFail(run(changed.dir, changed.head, L, { toolchain: join(WORK, 'no-such-toolchain') }), /not installed/));
await test('fail closed: the stand-in compiler crashes', () => {
  const broken = join(WORK, 'broken-toolchain');
  write(broken, 'typescript/bin/tsc', 'throw new Error("boom");\n');
  expectFail(run(changed.dir, changed.head, L, { toolchain: broken }), /could not compile/);
});

// The real repository: main's current pin.
await test("real repo: main's current pin is well-formed and passes the guard against itself", () => {
  const head = git(repoRoot, 'rev-parse', 'HEAD');
  assert.match(git(repoRoot, 'show', `${head}:${PIN_PATH}`) + '\n', PIN_RE);
  const eventPath = join(WORK, 'real-event.json');
  writeFileSync(eventPath, JSON.stringify({ pull_request: { head: { sha: head }, labels: [] } }));
  // --merge-base HEAD: does not depend on how the runner fetched main.
  expectPass(run(repoRoot, head, [], { args: ['--merge-base', head, '--head', head, '--event', eventPath, '--toolchain', TOOLCHAIN, '--scratch', join(WORK, 'real')] }));
});
if (process.env.PIN_GUARD_TOOLCHAIN) {
  await test("real repo: rebuilt with main's real TypeScript and scripts, HEAD reproduces its committed pin", () => {
    const head = git(repoRoot, 'rev-parse', 'HEAD');
    const { hash, manifest } = guard.rebuildWithMain(head, { toolchain: process.env.PIN_GUARD_TOOLCHAIN, scratch: join(WORK, 'real-rebuild') });
    assert.equal(hash, git(repoRoot, 'show', `${head}:${PIN_PATH}`).slice(0, 64));
    assert.ok(manifest.includes('  l1/dist/src/chain.js\n'));
    console.log(`  rebuilt ${head}: ${hash} (${manifest.trim().split('\n').length} tar members)`);
  });
} else {
  console.log('# real TypeScript rebuild of HEAD not run here: set PIN_GUARD_TOOLCHAIN to l1/node_modules installed from main\'s lockfile with --ignore-scripts');
}

// Pure parts.
await test('evaluatePinGuard: the label never rescues a failing pin', () => {
  const good = `${'a'.repeat(64)}  zyron-supply-verifier.tar\n`;
  const moved = `${'b'.repeat(64)}  zyron-supply-verifier.tar\n`;
  for (const [headPin, rebuild] of [[null, null], ['', null], ['nope\n', null], [`${'A'.repeat(64)}\n`, null], [moved, { hash: 'a'.repeat(64) }], [moved, { error: 'x' }], [moved, null]]) {
    const r = evaluatePinGuard({ basePin: good, headPin, changedPaths: ['l1/src/chain.ts', PIN_PATH], labels: L, rebuild });
    assert.equal(r.ok, false, `headPin ${JSON.stringify(headPin)} rebuild ${JSON.stringify(rebuild)} must fail even with the label`);
  }
  assert.equal(evaluatePinGuard({ basePin: good, headPin: moved, changedPaths: ['l1/src/chain.ts', PIN_PATH], labels: L, rebuild: { hash: 'b'.repeat(64) } }).ok, true);
});
await test('PIN_RE matches the regex in tools/supply-verifier/pin-hash.mjs', () => {
  const m = readFileSync(join(repoRoot, 'tools/supply-verifier/pin-hash.mjs'), 'utf8').match(/const PIN_RE = (\/.*\/);/);
  assert.ok(m, 'PIN_RE not found in pin-hash.mjs');
  assert.equal(String(PIN_RE), m[1]);
});
await test('isHashInput covers every tar input and build step, and not the pin itself', () => {
  for (const p of ['l1/src/chain.ts', 'l1/package.json', 'l1/package-lock.json', 'l1/tsconfig.json', 'tools/supply-verifier/cli.mjs', 'tools/supply-verifier/src/verify.mjs', 'tools/supply-verifier/package.json', 'tools/supply-verifier/package-lock.json', 'tools/supply-verifier/build.mjs', 'tools/supply-verifier/hash.mjs', 'tools/supply-verifier/pin-hash.mjs', 'tools/supply-verifier/.nvmrc', 'package.json', 'package-lock.json', '.npmrc']) assert.ok(isHashInput(p), p);
  for (const p of [PIN_PATH, 'README.md', 'docs/SUPPLY_VERIFIER.md', 'tools/supply-verifier/README.md', 'tools/supply-verifier/evidence/x.txt', 'tools/supply-verifier/test/build.test.mjs', '.github/workflows/l1.yml']) assert.ok(!isHashInput(p), p);
});
await test('supply-sensitive list is explicit, small, and every path exists in the repo', () => {
  assert.deepEqual([...SUPPLY_SENSITIVE_PATHS], ['l1/src/tokenomics.ts', 'l1/src/supply-report.ts', 'l1/src/allocation-locks.ts', 'l1/src/miner-genesis.ts', 'l1/src/founder-vesting.ts', 'l1/genesis-message.json', 'docs/fixed-supply-launch-plan.json', 'l1/scripts/validate-fixed-supply-genesis.mjs']);
  for (const p of SUPPLY_SENSITIVE_PATHS) assert.ok(existsSync(join(repoRoot, p)), `${p} does not exist`);
  for (const p of ['tools/supply-verifier/src/verify.mjs', 'tools/supply-verifier/build.mjs', 'tools/supply-verifier/pin-hash.mjs']) assert.ok(isSupplySensitive(p), p);
  for (const p of ['l1/src/chain.ts', 'tools/supply-verifier/test/build.test.mjs', 'tools/supply-verifier/README.md', PIN_PATH]) assert.ok(!isSupplySensitive(p), p);
});
await test('manifestDiff reports changed, added and removed members', () => {
  const d = manifestDiff(`${'1'.repeat(64)}  a\n${'2'.repeat(64)}  b\n${'3'.repeat(64)}  c\n`, `${'1'.repeat(64)}  a\n${'9'.repeat(64)}  b\n${'4'.repeat(64)}  d\n`);
  assert.equal(d.same, 1); assert.equal(d.total, 4);
  assert.deepEqual(d.rows.map((r) => r.split('|').at(-2).trim()), ['changed', 'removed', 'added']);
});

rmSync(WORK, { recursive: true, force: true });
console.log(`\nsupply-verifier pin guard tests: ${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
