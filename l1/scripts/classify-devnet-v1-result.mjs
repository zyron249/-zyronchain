#!/usr/bin/env node
// Classifies the result of the informational protocol-v1 `local-devnet` CI job
// (backlog P1-04). It never changes the result: the devnet step keeps its own
// exit status and this script only explains it.
//
// Protocol v1 keeps the legacy F-01 consensus split, so the two-validator v1
// devnet stalls in about half of the runs. Exactly two timeout messages from
// scripts/local-devnet.mjs are that known stall. Any other failure is reported
// as a real regression, and this script then exits non-zero as well.
// The F-01 fix is protocol v6, which the `local-devnet-v6` job exercises.
// See docs/L1_TEST_RELIABILITY.md.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const KNOWN_V1_FLAKE_MESSAGES = Object.freeze([
  'Timed out: transfer finalized by both validators',
  'Timed out: finality resumes after validator restart'
]);

const DOCS = 'docs/L1_TEST_RELIABILITY.md';

// First error line printed by local-devnet.mjs (`console.error(error.stack)`).
export function firstErrorMessage(text) {
  const match = String(text).match(/^(?:\S+ )?(?:[A-Za-z]*Error)(?: \[[A-Z_]+\])?: (.*)$/m);
  return match ? match[1] : null;
}

export function classifyDevnetV1Result(text, outcome) {
  const log = String(text ?? '');
  if (outcome === 'success') {
    if (!/"ok": true/.test(log) || !/"restartVerified": true/.test(log)) {
      return { kind: 'regression', level: 'error', title: 'Protocol-v1 devnet: inconsistent result',
        message: `The devnet step succeeded but its log has no ok/restartVerified summary. Treat this as a regression. See ${DOCS}.` };
    }
    return { kind: 'pass', level: 'notice', title: 'Protocol-v1 devnet passed (informational)',
      message: `local-devnet runs protocol v1 (legacy F-01 split, about 50% pass). It is informational and not a required check. The F-01 fix is exercised by local-devnet-v6. See ${DOCS}.` };
  }
  if (outcome !== 'failure') {
    return { kind: 'not-run', level: 'notice', title: 'Protocol-v1 devnet did not run',
      message: `The devnet step outcome was "${outcome}". See ${DOCS}.` };
  }
  const error = firstErrorMessage(log);
  const known = error !== null && KNOWN_V1_FLAKE_MESSAGES.some(message => error.startsWith(message));
  if (known) {
    return { kind: 'known-flake', level: 'warning', title: 'Known protocol-v1 flake (F-01), not a regression', error,
      message: `local-devnet runs protocol v1, which has the legacy F-01 split and passes about 50% of the time. This failure ("${error.slice(0, 160)}") is the known v1 stall. It is informational and not a required check; local-devnet-v6 runs the F-01 fix. See ${DOCS}.` };
  }
  return { kind: 'regression', level: 'error', title: 'Protocol-v1 devnet: NOT the known F-01 flake', error,
    message: `This failure ("${(error ?? 'no error message found').slice(0, 160)}") is not one of the known protocol-v1 timeout messages. Treat it as a real regression and investigate. See ${DOCS}.` };
}

// GitHub workflow commands must not contain raw newlines, % or :: in the title.
const escapeData = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = value => escapeData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

export function annotation(result) {
  return `::${result.level} title=${escapeProperty(result.title)}::${escapeData(result.message)}`;
}

export function summaryMarkdown(result, outcome) {
  return [
    '### local-devnet (protocol v1, informational)',
    '',
    '| Outcome | Classification |',
    '|---|---|',
    `| ${outcome} | ${result.title} |`,
    '',
    result.message,
    ''
  ].join('\n');
}

function tail(path, lines) {
  return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
}

async function main() {
  const [logPath, outcome = process.env.DEVNET_OUTCOME ?? 'failure'] = process.argv.slice(2);
  const text = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  const result = classifyDevnetV1Result(text, outcome);
  console.log(annotation(result));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result, outcome));
  // Diagnostics only: print the end of each retained validator log so a stall
  // can be analysed from the job log. The devnet chain is disposable.
  const retained = text.match(/^Development data retained at (\S+);/m);
  if (outcome === 'failure' && retained) {
    for (const name of ['a', 'b']) {
      const path = join(retained[1], `${name}.log`);
      if (!existsSync(path)) continue;
      console.log(`::group::validator ${name} log (last 200 lines)`);
      console.log(tail(path, 200));
      console.log('::endgroup::');
    }
  }
  if (result.kind === 'regression') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
