import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = join(repo, 'deploy', 'open-testnet', 'snapshot-keeper.sh');
const workflow = join(repo, '.github', 'workflows', 'open-testnet-snapshot-keeper.yml');
const PIN = '11'.repeat(32);
const OTHER = '22'.repeat(32);

function pinText(hash) {
  return `env:\n  EXPECTED_GENESIS: ${hash}\n`;
}

function run({ genesis, pin = pinText(PIN), pinFile = true, height = '12' }) {
  const dir = mkdtempSync(join(tmpdir(), 'zyron-keeper-'));
  const bin = join(dir, 'bin');
  const log = join(dir, 'gh.log');
  mkdirSync(bin);
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
    *) shift ;;
  esac
done
printf '%s\\n' "HTTP/1.1 200 OK" "x-zyron-snapshot-height: ${height}" "x-zyron-genesis-hash: ${genesis}" > "$hdr"
printf 'sealed' > "$out"
`);
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [script], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ONCE: '1',
        INTERVAL: '3600',
        WORK: join(dir, 'work'),
        HOME: dir,
        REPO: 'example/repo',
        TAG: 'open-testnet-state',
        GATEWAY: 'https://gateway.test',
        ...(pinFile ? { PIN_FILE: join(dir, 'pin.yml') } : {})
      }
    });
    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr, gh: readFileSync(log, 'utf8') });
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
