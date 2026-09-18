import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const policy = JSON.parse(readFileSync(new URL('../../docs/l1-launch-authorization.json', import.meta.url)));
const verifier = fileURLToPath(new URL('./verify-launch-authorization.mjs', import.meta.url));
function check(value, passes) {
  const dir = mkdtempSync(join(tmpdir(), 'zyron-launch-'));
  try {
    const input = join(dir, 'policy.json'), output = join(dir, 'result.json');
    writeFileSync(input, JSON.stringify(value));
    const result = spawnSync(process.execPath, [verifier, '--policy', input, '--out', output], { encoding: 'utf8', timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status === 0, passes, result.stderr);
    assert.equal(existsSync(output), passes, 'invalid policy must not emit success evidence');
    if (passes) {
      const evidence = JSON.parse(readFileSync(output));
      assert.equal(evidence.launchReadinessVerified, false);
      assert.equal(evidence.resultKind, 'policy-consistency-only');
      assert.equal(evidence.publicTestnetActivationAllowed, false);
      assert.equal(evidence.publicTestnetRequiredGateCount, 9);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
test('canonical policy verifies consistency, never launch readiness', () => check(policy, true));
for (const field of ['publicTestnetActivationRequirements', 'mainnetActivationRequirements']) {
  for (const gate of policy[field]) test(`${field}: reject missing ${gate}`, () => {
    const value = structuredClone(policy);
    value[field] = value[field].filter(item => item !== gate);
    // Preserve length to defeat the old count-only check.
    value[field].push('unrelated-placeholder');
    check(value, false);
  });
  test(`${field}: reject duplicates`, () => check({ ...policy, [field]: [...policy[field], policy[field][0]] }, false));
  test(`${field}: reject malformed entry`, () => check({ ...policy, [field]: [...policy[field], null] }, false));
}
for (const field of ['publicTestnetActivationAllowed', 'mainnetActivationAllowed']) {
  test(`reject ${field} without real evidence`, () => check({ ...policy, [field]: true }, false));
}
test('reject authorization waiving readiness', () => check({ ...policy, authorizationDoesNotWaiveReadinessGates: false }, false));
