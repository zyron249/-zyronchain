import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, readdirSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repo, 'deploy', 'open-testnet', 'snapshot-keeper.sh');
const workflow = join(repo, '.github', 'workflows', 'open-testnet-snapshot-keeper.yml');
const PIN = '11'.repeat(32);
const OTHER = '22'.repeat(32);
const FAKE_SECRET = 'test-fake-state-secret-legacy-keeper';
const bearerOf = (secret) => createHmac('sha256', secret).update('zyron-open-testnet-snapshot-keeper-v1', 'utf8').digest('hex');
const DERIVED = bearerOf(FAKE_SECRET);
const DUMMY_SECRET = 'dummy-secret-0123456789abcdef';

function pinText(hash) {
  return `env:\n  EXPECTED_GENESIS: ${hash}\n`;
}

function run({ genesis = PIN, pin = pinText(PIN), pinFile = true, height = '12', secret = FAKE_SECRET, once = true, withoutNode = false, onStdout = null, bashArgs = [], extraEnv = {}, killAfterMs = 20_000 }) {
  const dir = mkdtempSync(join(tmpdir(), 'zyron-keeper-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'gh.log');
  const curlLog = join(dir, 'curl.log');
  const authLog = join(dir, 'auth.log');
  const tmp = join(dir, 'tmp');
  mkdirSync(bin);
  mkdirSync(tmp);
  writeFileSync(join(dir, 'pin.yml'), pin);
  writeFileSync(join(bin, 'gh'), `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1 $2" in
  "release view"|"release create"|"release upload") exit 0 ;;
  "api "*) cat ${JSON.stringify(join(dir, 'pin.yml'))}; exit 0 ;;
esac
exit 1
`);
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
hdr=""
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -D) hdr=$2; shift 2 ;;
    -o) out=$2; shift 2 ;;
    -H) case "$2" in @*) cat "\${2#@}" >> ${JSON.stringify(curlLog)}; printf '%s %s %s\\n' "\${2#@}" "$(stat -c %a "\${2#@}")" "$(stat -c %a "$(dirname "\${2#@}")")" >> ${JSON.stringify(authLog)} ;; *) printf '%s\\n' "$2" >> ${JSON.stringify(curlLog)} ;; esac; shift 2 ;;
    *) shift ;;
  esac
done
printf '%s\\n' "HTTP/1.1 200 OK" "x-zyron-snapshot-height: ${height}" "x-zyron-genesis-hash: ${genesis}" > "$hdr"
printf 'sealed' > "$out"
`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  let path = `${bin}:${process.env.PATH}`;
  if (withoutNode) {
    // Only the tools the script needs, and no node.
    const tools = join(dir, 'tools');
    mkdirSync(tools);
    for (const name of ['mkdir', 'chmod', 'mktemp', 'rm', 'cat', 'tr', 'awk', 'date', 'cp', 'sleep', 'grep', 'sed', 'sh', 'stat', 'dirname']) {
      const target = ['/usr/bin', '/bin'].map((d) => join(d, name)).find((p) => existsSync(p));
      if (target) symlinkSync(target, join(tools, name));
    }
    path = `${bin}:${tools}`;
  }
  return new Promise((resolve, reject) => {
    const env = {
        ...process.env,
        PATH: path,
        TMPDIR: tmp,
        ...(once ? { ONCE: '1' } : { ONCE: '' }),
        INTERVAL: '3600',
        WORK: join(dir, 'work'),
        HOME: dir,
        REPO: 'example/repo',
        TAG: 'open-testnet-state',
        GATEWAY: 'https://gateway.test',
        ZYRON_TESTNET_STATE_SECRET: secret,
        ...(pinFile ? { PIN_FILE: join(dir, 'pin.yml') } : {})
    };
    Object.assign(env, extraEnv);
    if (secret === null) delete env.ZYRON_TESTNET_STATE_SECRET;
    // Own process group, so a hang can be cleaned up by this child's PID alone.
    const child = spawn('/bin/bash', [...bashArgs, script], { env, detached: true });
    const killer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, killAfterMs);
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; if (onStdout) onStdout(stdout, child); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
      // The secret value must never reach stdout or stderr, in any run.
      // The secret value and its bearer must never reach stdout or stderr, in any run.
      if (secret && (stdout.includes(secret) || stderr.includes(secret))) return reject(new Error('the state secret appeared in the keeper output'));
      const bearer = secret ? bearerOf(secret) : DERIVED;
      if (stdout.includes(bearer) || stderr.includes(bearer)) return reject(new Error('the keeper bearer appeared in the keeper output'));
      resolve({ code, signal, stdout, stderr, gh: read(log), curl: read(curlLog), auth: read(authLog), tmpLeft: readdirSync(tmp) });
    });
  });
}

test('the machine keeper uploads a snapshot of the pinned genesis', async () => {
  const result = await run({ genesis: PIN });
  assert.equal(result.code, 0);
  assert.match(result.gh, /release upload/);
  assert.match(result.stdout, /published height 12 genesis 111111111111/);
  assert.doesNotMatch(result.stderr, /refused/);
});

test('the machine keeper does not upload a different genesis', async () => {
  const result = await run({ genesis: OTHER });
  assert.equal(result.code, 0);
  assert.doesNotMatch(result.gh, /release upload/);
  assert.match(result.stderr, /refused: snapshot genesis 222222222222 is not the pinned genesis 111111111111/);
});

test('the machine keeper does not upload when the pin is missing or repeated', async () => {
  for (const pin of ['env:\n  OTHER: 1\n', pinText(PIN) + pinText(OTHER)]) {
    const result = await run({ genesis: PIN, pin });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.gh, /release upload/);
    assert.match(result.stderr, /refused: pinned genesis unavailable/);
  }
});

test('the machine keeper reads the pin from the repository workflow when no local file is set', async () => {
  const result = await run({ genesis: PIN, pinFile: false });
  assert.equal(result.code, 0);
  assert.match(result.gh, /repos\/example\/repo\/contents\/\.github\/workflows\/open-testnet-snapshot-keeper\.yml\?ref=main/);
  assert.match(result.gh, /release upload/);
});

test('the scheduled workflow has exactly one pin and the machine keeper accepts that hash', async () => {
  const text = readFileSync(workflow, 'utf8');
  const pins = [...text.matchAll(/^[ \t]*EXPECTED_GENESIS:[ \t]*([0-9a-f]{64})[ \t]*$/gm)].map((match) => match[1]);
  assert.equal(pins.length, 1);
  const allowed = await run({ genesis: pins[0], pin: text });
  const refused = await run({ genesis: OTHER, pin: text });
  assert.match(allowed.gh, /release upload/);
  assert.doesNotMatch(refused.gh, /release upload/);
  assert.match(refused.stderr, /refused: snapshot genesis 222222222222/);
});

test('the machine keeper sends the derived keeper bearer (S2-7), never the raw secret, and not on a command line', async () => {
  const result = await run({ genesis: PIN });
  assert.equal(result.code, 0);
  assert.equal(result.curl, `Authorization: Bearer ${DERIVED}\n`);
  assert.doesNotMatch(result.curl, new RegExp(FAKE_SECRET));
  const source = readFileSync(script, 'utf8');
  assert.match(source, /curl [^\n]*-H "@\$auth_header"/, 'curl reads the header from a file');
  assert.doesNotMatch(source, /-H "Authorization/, 'the bearer is never a curl argument');
});

test('the machine keeper fails closed without ZYRON_TESTNET_STATE_SECRET (missing or empty), with a message that names no value', async () => {
  for (const secret of [null, '']) { // null = unset
    const result = await run({ secret });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /refusing to start: ZYRON_TESTNET_STATE_SECRET is missing or empty/);
    assert.equal(result.curl, '');
    assert.doesNotMatch(result.gh, /release upload/);
    assert.deepEqual(result.tmpLeft, [], 'no temp directory is left behind');
  }
});

test('the machine keeper fails closed when node is missing, without printing the secret', async () => {
  const result = await run({ withoutNode: true });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /refusing to start: node is not installed/);
  assert.equal(result.curl, '');
  assert.doesNotMatch(result.gh, /release upload/);
  assert.deepEqual(result.tmpLeft, []);
});

test('the bearer file is 0600 in a private mktemp -d directory and is removed on a normal exit', async () => {
  const result = await run({});
  assert.equal(result.code, 0);
  const [file, mode, dirMode] = result.auth.trim().split(' ');
  assert.match(file, /\/tmp\/zyron-keeper-auth\.[^/]+\/auth-header$/, 'inside a mktemp -d directory under TMPDIR');
  assert.equal(mode, '600');
  assert.equal(dirMode, '700');
  assert.equal(existsSync(file), false, 'the bearer file is gone after exit');
  assert.deepEqual(result.tmpLeft, [], 'the temp directory is gone after exit');
});

for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
  test(`the bearer file is removed when the keeper is stopped by ${sig} while it waits`, { timeout: 30_000 }, async () => {
    let sent = false;
    const result = await run({ once: false, onStdout: (out, child) => { if (!sent && /published height/.test(out)) { sent = true; setTimeout(() => child.kill(sig), 200); } } });
    assert.equal(sent, true, 'the keeper published one cycle before the signal');
    assert.equal(result.code, code, `exit ${code} after ${sig} (got code=${result.code} signal=${result.signal})`);
    const [file] = result.auth.trim().split(' ');
    assert.equal(existsSync(file), false);
    assert.deepEqual(result.tmpLeft, [], 'the temp directory is gone after the signal');
  });
}

test('the machine keeper script never echoes, logs or passes the secret or bearer on a command line', () => {
  const source = readFileSync(script, 'utf8');
  const code = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  assert.doesNotMatch(code, /set -x|xtrace/);
  assert.doesNotMatch(code, /(echo|printf)[^\n]*\$\{?ZYRON_TESTNET_STATE_SECRET/, 'the secret is never printed');
  assert.doesNotMatch(code, /(echo|printf)[^\n]*\$\{?auth_header\}?"?\s*$/m);
  assert.doesNotMatch(code, /curl [^\n]*-H "Authorization/, 'the bearer is never a curl argument');
  assert.doesNotMatch(code, /--hmac|-hmac|openssl/, 'no HMAC tool that takes the key as an argument');
  // node reads the secret from process.env; it is never interpolated into argv.
  assert.match(code, /process\.env\.ZYRON_TESTNET_STATE_SECRET/);
  assert.doesNotMatch(code, /node[^\n]*"\$\{?ZYRON_TESTNET_STATE_SECRET/);
  assert.match(code, /trap cleanup EXIT/);
  assert.match(code, /trap 'exit 130' INT/);
  assert.match(code, /trap 'exit 143' TERM/);
  assert.match(code, /mktemp -d/);
  assert.match(code, /unset ZYRON_TESTNET_STATE_SECRET/);
});

for (const [label, opts] of [['bash -x', { bashArgs: ['-x'] }], ['SHELLOPTS=xtrace', { extraEnv: { SHELLOPTS: 'xtrace' } }]]) {
  test(`under ${label} the dummy secret and its derived token never appear in stdout or stderr`, { timeout: 30_000 }, async () => {
    const result = await run({ secret: DUMMY_SECRET, ...opts }).catch((error) => ({ error }));
    assert.equal(result.error, undefined, String(result.error?.message ?? ''));
    assert.equal(result.code, 0);
    assert.match(result.stderr, /^\+ /m, 'xtrace was actually on');
    assert.equal(result.stdout.includes(DUMMY_SECRET) || result.stderr.includes(DUMMY_SECRET), false, 'dummy secret leaked');
    assert.equal(result.stdout.includes(bearerOf(DUMMY_SECRET)) || result.stderr.includes(bearerOf(DUMMY_SECRET)), false, 'derived token leaked');
    assert.equal(result.curl, `Authorization: Bearer ${bearerOf(DUMMY_SECRET)}\n`, 'the keeper still sent the derived token');
    assert.deepEqual(result.tmpLeft, []);
  });
}
