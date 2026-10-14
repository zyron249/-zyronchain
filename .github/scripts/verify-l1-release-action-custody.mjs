#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const CHECKOUT_SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const SETUP_NODE_SHA = '949feb2413d6458794dcd2491c4babbbce0c15c1';
const UPLOAD_ARTIFACT_SHA = 'cf430e030ddbb5b0abf93d22962f4752f3646cd9';
const ATTEST_SHA = '1e69f48acb82d1966a394da916b4c1698aa569d6';

// F-08: required commands must be effective steps. Comments are stripped
// before matching, and steps that can be skipped or ignored are refused, so a
// commented-out, conditional or continue-on-error step no longer satisfies a
// substring check.
export function stripYamlComments(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#(?![^'"]*['"]\s*$).*$/, ''))
    .join('\n');
}

export function verifyL1ReleaseWorkflow(rawWorkflow) {
const workflow = stripYamlComments(rawWorkflow);
if (/^\s*(?:-\s+)?continue-on-error\s*:/m.test(workflow)) throw new Error('Release workflow steps must not continue on error');
if (/^\s+(?:-\s+)?if\s*:/m.test(workflow)) throw new Error('Release workflow steps and jobs must not be conditional');
// F-08 residual: a shell line that ends the step early makes every later
// required command unreachable.
// Round-4 PR984: also through the `builtin` / `command` wrappers (and the
// same after a separator).
// Round-5 (Codex review of #997): bash removes quotes and backslashes before
// it looks a command name up, so `'exit' 0`, `e''xit 0`, `\exit 0` and the
// payload of `eval 'exit 0'` all still end the step. The scan also runs on a
// copy with quote and backslash characters removed, and `exec` (which replaces
// the shell, ending the step with the new program's status) counts as an exit.
// Round-5 (Codex review of #1009): ANSI-C (`$'...'`) and locale (`$"..."`)
// quoting can spell any word, including escapes such as `$'\145xit'`, and the
// release workflow does not use either form, so both are refused outright.
if (/\$['"]/.test(workflow)) throw new Error("Release workflow steps must not use $'...' or $\"...\" quoting");
const EARLY_EXIT = /(?:^|&&|\|\||;|\(|\{)\s*(?:(?:builtin|command|eval)\s+)*(?:exit|return|logout|exec)\b/m;
const dequoted = workflow.replace(/['"\\]/g, '');
if (EARLY_EXIT.test(workflow) || EARLY_EXIT.test(dequoted)) {
  throw new Error('Release workflow steps must not exit early');
}
// Round-5 (Codex review of #997): an `eval` payload can be computed at run time
// (`eval "$(printf ex)it 0"`), so no text check can prove it harmless. The
// release workflow has no use for it.
if (/(?:^|[\s;&|(){}`])eval(?=\s|$)/m.test(dequoted)) throw new Error('Release workflow steps must not use eval');
// Round-4 PR984: a heredoc turns the lines below it into data, so a required
// command inside one would be printed, not run. Run blocks must not use them.
// Round-5 (Codex review of #997): any heredoc operator is refused, whatever
// its delimiter (`<<9`, `<<'9'`, `<<\AUDIT`, `<<-.END`); only the here-string
// operator `<<<` (which reads no following lines) is left alone.
if (/(?<!<)<<(?!<)/.test(workflow)) throw new Error('Release workflow steps must not use heredocs');

const requireExactRef = (action, expected) => {
  const refs = [...workflow.matchAll(new RegExp(`actions/${action}@([0-9a-f]{40})`, 'g'))].map((m) => m[1]);
  if (refs.length !== 1 || refs[0] !== expected) throw new Error(`Standalone L1 release ${action} pin drift`);
  if (new RegExp(`actions/${action}@(?![0-9a-f]{40}\\b)[^\\s]+`).test(workflow)) throw new Error(`Mutable ${action} ref in release workflow`);
};

requireExactRef('checkout', CHECKOUT_SHA);
requireExactRef('setup-node', SETUP_NODE_SHA);
requireExactRef('upload-artifact', UPLOAD_ARTIFACT_SHA);
requireExactRef('attest', ATTEST_SHA);

const checkoutIndex = workflow.indexOf(`uses: actions/checkout@${CHECKOUT_SHA}`);
if (checkoutIndex < 0) throw new Error('release checkout missing');
const nextStep = workflow.indexOf('\n      - name:', checkoutIndex + 1);
const checkoutStep = workflow.slice(checkoutIndex, nextStep === -1 ? workflow.length : nextStep);
if (!/^\s*persist-credentials:\s*false\b/m.test(checkoutStep)) throw new Error('release checkout must disable credential persistence');

for (const required of [
  'permissions:\n  contents: read',
  'id-token: write',
  'attestations: write',
  'npm ci',
  'npm run typecheck',
  'npm test',
  'npm audit --omit=dev --audit-level=high',
  'npm sbom --omit=dev --sbom-format=spdx',
  'sha256sum SBOM.spdx.json zyronchain-l1-*.tgz > SHA256SUMS',
  'npm pack --ignore-scripts --pack-destination release'
]) {
  if (!workflow.includes(required)) throw new Error(`Required release security invariant missing: ${required}`);
}

// Line-based (no backtracking): a required command must be the whole value of
// a run step or a whole line of a `run: |` block.
const effectiveRunCommands = new Set();
{
  const lines = workflow.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^(\s+)(?:-\s+)?run:\s*(.*?)\s*$/);
    if (!m) continue;
    if (m[2] !== '|') { effectiveRunCommands.add(m[2]); continue; }
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === '') continue;
      if (lines[j].length - lines[j].trimStart().length <= indent) break;
      effectiveRunCommands.add(lines[j].trim());
    }
  }
}
for (const required of ['npm run typecheck', 'npm test', 'npm audit --omit=dev --audit-level=high']) {
  if (!effectiveRunCommands.has(required)) {
    throw new Error(`Required release step is not an effective run step: ${required}`);
  }
}
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyL1ReleaseWorkflow(await readFile(new URL('../workflows/l1-release.yml', import.meta.url), 'utf8'));
  console.log('l1-release-action-custody: ok');
}
