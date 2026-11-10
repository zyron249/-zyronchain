#!/usr/bin/env node
// Supply-verifier pin guard: the checker run by
// .github/workflows/supply-verifier-pin-guard.yml.
//
// WHAT IT GUARDS. tools/supply-verifier/EXPECTED_SHA256 pins the SHA-256 of
// tools/supply-verifier/dist/zyron-supply-verifier.tar, the reproducible ustar
// built by tools/supply-verifier/build.mjs --clean-l1 (via pin-hash.mjs). The
// tar holds the verifier sources (cli.mjs, package.json, package-lock.json,
// src/**/*.mjs), l1/package.json, l1/package-lock.json and l1/dist/src/*.js
// compiled by `npm ci` + `tsc` in l1/.
//
// HOW IT RUNS. The workflow uses pull_request_target on PRs into main, so
// GitHub runs the workflow file and THIS checker exactly as they are on main:
// a PR cannot edit or disable the checker it is judged by. The PR head is read
// as git data only (git show / git diff on fetched objects). Nothing from the
// PR is checked out, installed, imported, built or executed. Labels come from
// the event payload ($GITHUB_EVENT_PATH), not from an API call.
//
// WHAT IT CHECKS, against the merge base of the PR head with main:
//  1. EXPECTED_SHA256 exists at the head as a regular file and is well-formed
//     (same regex as pin-hash.mjs --validate). Always, label or not.
//  2. Rebuild with MAIN's scripts. When the pin or any hashed input changed,
//     the tar is rebuilt from the PR head's files, read as git blobs into a
//     scratch directory, using main's l1/tsconfig.json, main's TypeScript
//     (installed by the workflow from MAIN's l1/package-lock.json with
//     --ignore-scripts, before any PR data is fetched) and main's
//     tools/supply-verifier/build.mjs and hash.mjs. The rebuilt hash must
//     equal the head's EXPECTED_SHA256. This also catches a hashed input that
//     changed while the pin did not. The PR's own build scripts are never run.
//     If the head changes the TypeScript toolchain entries of
//     l1/package-lock.json or l1/tsconfig.json relative to main, main's
//     toolchain cannot reproduce the PR's build, so the guard fails closed and
//     says so. The per-file MANIFEST.sha256 diff (merge base vs head, both
//     rebuilt with main's scripts) is printed and written to the job summary.
//  3. If the pin changed, at least one file that feeds the hashed tar (or its
//     build) changed too (a reproducible build of unchanged inputs cannot move).
//  4. If the pin changed, or any SUPPLY_SENSITIVE_PATHS entry changed, the PR
//     carries the label `patron-approved-pin`.
// The label is a second gate only and never a bypass: 1-3 fail with it.
//
// WHAT IT DOES NOT DO. It never executes PR content: no npm, no PR scripts,
// no import of PR files. TypeScript only parses and emits the PR's l1/src.
// It does not replace supply-verifier-reproducible.yml (two fresh builds) or
// Security's independent rebuild (CONTRIBUTING.md); it adds a main-owned
// rebuild next to them.
//
// LIMITS. Running from main closes the gap where a PR edits the checker that
// judges it. The label is still advisory: every bot acts through the same
// zyron249 account, so any of them can add it, and the payload does not show
// whether it was added after the last push. The guard only blocks a merge once
// branch protection makes it required, which is the repository owner's call.
//
//   node .github/scripts/verify-supply-verifier-pin-guard.mjs \
//     --merge-base origin/main --head <40-hex sha> --event "$GITHUB_EVENT_PATH" \
//     --toolchain l1/node_modules --scratch "$RUNNER_TEMP/pin-guard"
// Exits 0 only on an explicit pass. Any error exits 1 (fail closed).
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// main's checkout: this file lives at .github/scripts/ in it.
const MAIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PIN_PATH = 'tools/supply-verifier/EXPECTED_SHA256';
export const APPROVAL_LABEL = 'patron-approved-pin';
// Kept identical to PIN_RE in tools/supply-verifier/pin-hash.mjs (a test asserts it).
export const PIN_RE = /^[0-9a-f]{64}(?:[ \t]+\S.*)?[ \t]*\r?\n?$/;

// Paths that are NOT inputs of the hashed tar or of its build. Everything else
// under l1/ and tools/supply-verifier/, plus root npm config, counts as an
// input. Erring towards "input" only makes check 2 more permissive, never
// stricter than the truth.
const SV = 'tools/supply-verifier/';
const NOT_INPUT_UNDER_SV = [PIN_PATH, `${SV}README.md`];
const NOT_INPUT_DIRS_UNDER_SV = [`${SV}evidence/`, `${SV}test/`, `${SV}dist/`];
const ROOT_INPUTS = new Set(['package.json', 'package-lock.json', '.npmrc']);

// Supply, genesis and allocation files (docs/design pin-guard notes of
// 2026-11-10, checked against the repo). Kept explicit and small; any change
// to one of these needs the label even when the pin did not move.
export const SUPPLY_SENSITIVE_PATHS = Object.freeze([
  'l1/src/tokenomics.ts',
  'l1/src/supply-report.ts',
  'l1/src/allocation-locks.ts',
  'l1/src/miner-genesis.ts',
  'l1/src/founder-vesting.ts',
  'l1/genesis-message.json',
  'docs/fixed-supply-launch-plan.json',
  'l1/scripts/validate-fixed-supply-genesis.mjs',
]);
// Directory prefix and top-level build scripts of the verifier.
export const SUPPLY_SENSITIVE_PREFIXES = Object.freeze(['tools/supply-verifier/src/']);
export const SUPPLY_SENSITIVE_SCRIPTS_RE = /^tools\/supply-verifier\/[^/]+\.mjs$/;

export function isSupplySensitive(path) {
  return SUPPLY_SENSITIVE_PATHS.includes(path) || SUPPLY_SENSITIVE_PREFIXES.some((prefix) => path.startsWith(prefix)) || SUPPLY_SENSITIVE_SCRIPTS_RE.test(path);
}

export function isHashInput(path) {
  if (ROOT_INPUTS.has(path)) return true;
  if (path.startsWith('l1/')) return true;
  if (path.startsWith(SV)) {
    if (NOT_INPUT_UNDER_SV.includes(path)) return false;
    if (NOT_INPUT_DIRS_UNDER_SV.some((dir) => path.startsWith(dir))) return false;
    return true;
  }
  return false;
}

/**
 * Pure decision. basePin/headPin: file text, or null when absent (or not a
 * regular file). changedPaths: paths that differ between merge base and head.
 * labels: label names from the event payload. rebuild: null when no rebuild
 * was needed (pin and hashed inputs unchanged), else { hash } or { error }.
 */
export function evaluatePinGuard({ basePin, headPin, changedPaths, labels, rebuild = null }) {
  const errors = [];
  const notes = [];
  const inputsChanged = changedPaths.filter(isHashInput);
  const supplyChanged = changedPaths.filter(isSupplySensitive);
  const hasLabel = labels.includes(APPROVAL_LABEL);
  const wellFormed = headPin !== null && PIN_RE.test(headPin);
  if (headPin === null) {
    errors.push(`${PIN_PATH} is missing or deleted at the PR head (or is not a regular file). The pin must stay committed.`);
  } else if (!wellFormed) {
    errors.push(`${PIN_PATH} is malformed: it must hold exactly 64 lowercase hex characters, optionally followed by whitespace and a filename.`);
  }
  const pinChanged = basePin !== headPin;
  if (wellFormed && (pinChanged || inputsChanged.length > 0)) {
    const want = headPin.slice(0, 64);
    if (!rebuild) errors.push('a rebuild with main\'s scripts is required for this change but did not run.');
    else if (rebuild.error) errors.push(`could not rebuild the tar from the PR head with main's scripts: ${rebuild.error}`);
    else if (rebuild.hash !== want) errors.push(`rebuilt with main's scripts, the tar sha256 is ${rebuild.hash}, but ${PIN_PATH} says ${want}. The label does not override this.`);
    else notes.push(`rebuilt with main's scripts: ${rebuild.hash} matches ${PIN_PATH}.`);
  }
  if (pinChanged) {
    // A first pin (none at the merge base) is not a move; the rebuild still checks it.
    if (basePin !== null && headPin !== null && inputsChanged.length === 0) {
      errors.push(`${PIN_PATH} changed, but no file that feeds the hashed tar changed (l1/**, the verifier sources or build scripts, root npm config). A reproducible build of unchanged inputs gives the same hash, so the new pin cannot be right.`);
    }
    if (!hasLabel) {
      errors.push(`${PIN_PATH} changed, and the approval label "${APPROVAL_LABEL}" is missing. Add it only after Patron approves the pin move and Security has rebuilt it independently (see CONTRIBUTING.md).`);
    }
  }
  if (supplyChanged.length > 0 && !hasLabel) {
    errors.push(`supply, genesis or allocation files changed (${supplyChanged.join(', ')}), and the approval label "${APPROVAL_LABEL}" is missing.`);
  }
  return { ok: errors.length === 0, pinChanged, inputsChanged, supplyChanged, errors, notes };
}

const REV_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function gitBytes(args) {
  return execFileSync('git', args, { maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function lsTree(commit, paths) {
  const out = git(['ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths]);
  return out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, oid] = line.slice(0, tab).split(' ');
    return { mode, type, oid, path: line.slice(tab + 1) };
  });
}
function readBlob(commit, path) {
  const entry = lsTree(commit, [path]).find((e) => e.path === path);
  if (!entry || entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) return null;
  return gitBytes(['cat-file', 'blob', entry.oid]);
}
function readPin(commit) {
  const data = readBlob(commit, PIN_PATH);
  return data === null ? null : data.toString('utf8');
}

// Files the tar needs from the tree, as data (see build.mjs). l1/src is
// compiled; the rest is packed verbatim.
const TREE_FILES = ['tools/supply-verifier/cli.mjs', 'tools/supply-verifier/package.json', 'tools/supply-verifier/package-lock.json', 'l1/package.json', 'l1/package-lock.json'];
const TREE_DIRS = ['tools/supply-verifier/src', 'l1/src'];

/** Writes the tar's source files of `commit` into `dest` as plain bytes. */
export function materialize(commit, dest) {
  const entries = lsTree(commit, [...TREE_FILES, ...TREE_DIRS]);
  for (const file of TREE_FILES) if (!entries.some((e) => e.path === file)) throw new Error(`${file} is missing at ${commit}`);
  for (const e of entries) {
    if (e.type !== 'blob' || (e.mode !== '100644' && e.mode !== '100755')) throw new Error(`${e.path} is not a regular file (mode ${e.mode}); refusing to build it`);
    if (isAbsolute(e.path) || e.path.split('/').some((part) => part === '..' || part === '.' || part === '')) throw new Error(`unsafe path ${JSON.stringify(e.path)}`);
    const out = join(dest, e.path);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, gitBytes(['cat-file', 'blob', e.oid]));
  }
}

/** TypeScript toolchain entries of a lockfile (they decide the emitted JS). */
export function toolchainEntries(lockText) {
  const lock = JSON.parse(lockText);
  const pkgs = lock?.packages;
  if (!pkgs || typeof pkgs !== 'object') throw new Error('l1/package-lock.json has no packages map');
  const picked = {};
  for (const [key, value] of Object.entries(pkgs)) if (key === 'node_modules/typescript' || key.startsWith('node_modules/@typescript/')) picked[key] = value;
  return JSON.stringify(picked);
}

/**
 * Rebuilds the tar from `commit` with main's tsconfig, TypeScript and
 * build/hash scripts. Returns { hash, manifest } or throws.
 */
export function rebuildWithMain(commit, { toolchain, scratch }) {
  toolchain = resolve(toolchain);
  scratch = resolve(scratch);
  const mainLock = readFileSync(join(MAIN_ROOT, 'l1/package-lock.json'), 'utf8');
  const mainTsconfig = readFileSync(join(MAIN_ROOT, 'l1/tsconfig.json'));
  const headLock = readBlob(commit, 'l1/package-lock.json');
  const headTsconfig = readBlob(commit, 'l1/tsconfig.json');
  if (headLock === null) throw new Error('l1/package-lock.json is missing');
  if (toolchainEntries(headLock.toString('utf8')) !== toolchainEntries(mainLock)) throw new Error("the TypeScript toolchain in l1/package-lock.json differs from main's, so main's toolchain cannot reproduce this build; land the toolchain change separately or ask Security to rebuild independently");
  if (headTsconfig === null || !headTsconfig.equals(mainTsconfig)) throw new Error("l1/tsconfig.json differs from main's, so main's toolchain cannot reproduce this build; land it separately or ask Security to rebuild independently");
  const tsc = join(toolchain, 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) throw new Error(`main's TypeScript is not installed at ${tsc}`);
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  materialize(commit, scratch);
  writeFileSync(join(scratch, 'l1/tsconfig.json'), mainTsconfig);
  symlinkSync(toolchain, join(scratch, 'l1/node_modules'), 'dir');
  // Main's scripts, copied next to the data (build.mjs resolves paths from its own location).
  for (const script of ['build.mjs', 'hash.mjs']) copyFileSync(join(MAIN_ROOT, 'tools/supply-verifier', script), join(scratch, 'tools/supply-verifier', script));
  const l1 = join(scratch, 'l1');
  try {
    execFileSync(process.execPath, [tsc, '-p', join(l1, 'tsconfig.json'), '--outDir', join(l1, 'dist'), '--rootDir', l1], { cwd: l1, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (error) {
    throw new Error(`main's TypeScript could not compile the PR's l1/src: ${String(error.stdout ?? '').split('\n').slice(0, 20).join(' | ')}`);
  }
  execFileSync(process.execPath, [join(scratch, 'tools/supply-verifier/build.mjs')], { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] });
  const line = execFileSync(process.execPath, [join(scratch, 'tools/supply-verifier/hash.mjs')], { cwd: scratch, encoding: 'utf8' });
  const hash = line.slice(0, 64);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`unexpected hash output ${JSON.stringify(line)}`);
  const manifest = readFileSync(join(scratch, 'tools/supply-verifier/dist/MANIFEST.sha256'), 'utf8');
  return { hash, manifest };
}

function parseManifest(text) {
  const map = new Map();
  for (const line of text.split('\n').filter(Boolean)) map.set(line.slice(66), line.slice(0, 64));
  return map;
}
/** Per-file diff of two MANIFEST.sha256 texts, as markdown table rows. */
export function manifestDiff(baseText, headText) {
  const base = parseManifest(baseText);
  const head = parseManifest(headText);
  const names = [...new Set([...base.keys(), ...head.keys()])].sort();
  const rows = [];
  let same = 0;
  for (const name of names) {
    const b = base.get(name);
    const h = head.get(name);
    if (b === h) { same += 1; continue; }
    rows.push(`| \`${name}\` | ${b ? `\`${b}\`` : '(absent)'} | ${h ? `\`${h}\`` : '(absent)'} | ${!b ? 'added' : !h ? 'removed' : 'changed'} |`);
  }
  return { same, total: names.length, rows };
}

const OPTIONS = ['--merge-base', '--head', '--event', '--toolchain', '--scratch'];
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!OPTIONS.includes(key) || argv[i + 1] === undefined) throw new Error(`usage: --merge-base <rev> --head <sha> --event <path> --toolchain <dir> --scratch <dir> (bad argument ${JSON.stringify(key)})`);
    out[key.slice(2)] = argv[i + 1];
  }
  for (const key of OPTIONS) if (!out[key.slice(2)]) throw new Error('usage: --merge-base <rev> --head <sha> --event <path> --toolchain <dir> --scratch <dir>');
  if (!/^[0-9a-f]{40}$/.test(out.head)) throw new Error('--head must be a 40-character lowercase hex commit SHA');
  if (!REV_RE.test(out['merge-base'])) throw new Error('--merge-base must be a plain revision name');
  return out;
}

export function main(argv) {
  const args = parseArgs(argv);
  const event = JSON.parse(readFileSync(args.event, 'utf8'));
  const pr = event?.pull_request;
  if (!pr || !Array.isArray(pr.labels)) throw new Error('event payload has no pull_request.labels array');
  if (pr.head?.sha !== args.head) throw new Error(`event head SHA ${JSON.stringify(pr.head?.sha)} does not match --head ${args.head}`);
  const labels = pr.labels.map((label) => {
    if (typeof label?.name !== 'string') throw new Error('event payload has a label without a string name');
    return label.name;
  });
  git(['cat-file', '-e', `${args.head}^{commit}`]);
  const mainCommit = git(['rev-parse', '--verify', '--end-of-options', `${args['merge-base']}^{commit}`]).trim();
  const base = git(['merge-base', mainCommit, args.head]).trim();
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('no merge base between main and the PR head');
  const changedPaths = git(['diff', '--no-renames', '--name-only', '-z', base, args.head]).split('\0').filter(Boolean);
  const basePin = readPin(base);
  const headPin = readPin(args.head);
  const pinChanged = basePin !== headPin;
  const needsRebuild = headPin !== null && PIN_RE.test(headPin) && (pinChanged || changedPaths.some(isHashInput));
  const toolchain = resolve(args.toolchain);
  const scratch = resolve(args.scratch);
  let rebuild = null;
  const summary = [];
  if (needsRebuild) {
    try { rebuild = rebuildWithMain(args.head, { toolchain, scratch: join(scratch, 'head') }); } catch (error) { rebuild = { error: error?.message ?? String(error) }; }
    if (rebuild.manifest) {
      let baseManifest = null;
      try { baseManifest = rebuildWithMain(base, { toolchain, scratch: join(scratch, 'base') }).manifest; } catch (error) { summary.push(`Merge base could not be rebuilt with main's scripts (${error?.message ?? error}); no per-file diff.`); }
      if (baseManifest !== null) {
        const diff = manifestDiff(baseManifest, rebuild.manifest);
        summary.push(`Tar members, merge base vs PR head (both rebuilt with main's scripts): ${diff.same} of ${diff.total} identical, ${diff.rows.length} differ.`);
        if (diff.rows.length) summary.push('', '| Tar member | sha256 at merge base | sha256 at PR head | |', '|---|---|---|---|', ...diff.rows);
      }
    }
  }
  const result = evaluatePinGuard({ basePin, headPin, changedPaths, labels, rebuild });
  console.log(`merge base ${base}, head ${args.head}`);
  console.log(`pin changed: ${result.pinChanged ? 'yes' : 'no'}; hashed inputs changed: ${result.inputsChanged.length}; supply-sensitive changed: ${result.supplyChanged.length}; rebuild: ${needsRebuild ? 'yes' : 'not needed'}; labels: ${JSON.stringify(labels)}`);
  for (const line of summary) console.log(line);
  for (const note of result.notes) console.log(`note: ${note}`);
  for (const error of result.errors) console.log(`::error::${error}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## Supply verifier pin guard', '', result.ok ? 'Result: pass' : 'Result: FAIL', '', ...result.errors.map((e) => `- ${e}`), ...result.notes.map((n) => `- ${n}`), '', ...summary, ''].join('\n'));
  }
  return result.ok;
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  let ok = false;
  try { ok = main(process.argv.slice(2)); } catch (error) { console.log(`::error::${error?.message ?? error}`); ok = false; }
  console.log(ok ? 'supply-verifier pin guard: ok' : 'supply-verifier pin guard: FAILED');
  process.exit(ok ? 0 : 1);
}
