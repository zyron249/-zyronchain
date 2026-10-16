#!/usr/bin/env node
// Classifies the result of the informational protocol-v1 `local-devnet` CI job
// (backlog P1-04). It never changes the result: the devnet step keeps its own
// exit status and this script only explains it.
//
// Protocol v1 keeps the legacy F-01 consensus split, so the two-validator v1
// devnet stalls in about half of the runs. Only a failure that matches the
// full stall signature below is reported as that known flake. Any other
// failure is reported as a real regression, and this script then exits
// non-zero as well.
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

// The known v1 stall has one signature, and every part of it must be present:
// 1. the harness timed out with one of the two known labels and no wrapped
//    assertion (only a connection error from a restarting peer is allowed);
// 2. last-status shows both validators at the same height H with the same tip
//    (stalled and agreeing: no split, no progress beyond H);
// 3. every validator log shows the v1 round-skip quorum failing at height H+1
//    ("Round skip certificate incomplete: height=H+1 ... quorum not reached")
//    and no validator finalized a block above H.
// A timeout caused by wrong balances, a wrong nonce or a diverged chain fails
// at least one of these checks and is reported as a regression.
const STALL = /^Timed out: (transfer finalized by both validators|finality resumes after validator restart)(?: \((?:fetch failed|[^()]*ECONNREFUSED[^()]*)\))? last-status=(\[.*\])$/;

export function knownStallEvidence(error, validatorLogs) {
  if (error === null) return { ok: false, reason: 'no error message found' };
  const match = error.match(STALL);
  if (!match) return { ok: false, reason: 'not a bare known timeout (a wrapped assertion or another message)' };
  let status;
  try { status = JSON.parse(match[2]); } catch { return { ok: false, reason: 'last-status is not parseable' }; }
  if (!Array.isArray(status) || status.length !== 2 || status.some(item => !item || typeof item !== 'object' ||
      !Number.isSafeInteger(item.height) || typeof item.tipHash !== 'string')) {
    return { ok: false, reason: 'last-status does not show both validators' };
  }
  const [a, b] = status;
  if (a.height !== b.height || a.tipHash !== b.tipHash || a.chainId !== b.chainId) {
    return { ok: false, reason: 'validators disagree in last-status (height, tip or chain)' };
  }
  const logs = Object.values(validatorLogs ?? {});
  if (logs.length !== 2) return { ok: false, reason: 'validator logs are not available' };
  const next = a.height + 1;
  const skip = new RegExp(`Round skip certificate incomplete: height=${next} round=\\d+ protocolVersion=1 error=Round skip quorum not reached`);
  for (const log of logs) {
    if (!skip.test(log)) return { ok: false, reason: `a validator log has no protocol-v1 round-skip quorum failure at height ${next}` };
    for (const finalized of log.matchAll(/Finalized block (\d+) /g)) {
      if (Number(finalized[1]) > a.height) return { ok: false, reason: `a validator finalized block ${finalized[1]} above the stalled height ${a.height}` };
    }
  }
  return { ok: true, label: match[1], height: a.height };
}

export function classifyDevnetV1Result(text, outcome, validatorLogs) {
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
  const evidence = knownStallEvidence(error, validatorLogs);
  const shown = (error ?? 'no error message found').replace(/ last-status=.*$/, '').slice(0, 160);
  if (evidence.ok) {
    return { kind: 'known-flake', level: 'warning', title: 'Known protocol-v1 flake (F-01), not a regression', error,
      message: `local-devnet runs protocol v1, which has the legacy F-01 split and passes about 50% of the time. This failure ("${shown}") matches the known v1 stall: both validators agree at height ${evidence.height} and the round-skip quorum fails at height ${evidence.height + 1}. It is informational and not a required check; local-devnet-v6 runs the F-01 fix. See ${DOCS}.` };
  }
  return { kind: 'regression', level: 'error', title: 'Protocol-v1 devnet: NOT the known F-01 flake', error,
    message: `This failure ("${shown}") does not match the known protocol-v1 stall (${evidence.reason}). Treat it as a real regression and investigate. See ${DOCS}.` };
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

async function main() {
  const [logPath, outcome = process.env.DEVNET_OUTCOME ?? 'failure'] = process.argv.slice(2);
  const text = logPath && existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
  // The harness keeps its disposable chain directory (with a.log and b.log)
  // whenever --check fails.
  const retained = text.match(/^Development data retained at (\S+);/m);
  const validatorLogs = {};
  if (retained) {
    for (const name of ['a', 'b']) {
      const path = join(retained[1], `${name}.log`);
      if (existsSync(path)) validatorLogs[name] = readFileSync(path, 'utf8');
    }
  }
  const result = classifyDevnetV1Result(text, outcome, validatorLogs);
  console.log(annotation(result));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryMarkdown(result, outcome));
  // Diagnostics only: print the end of each validator log so a stall can be
  // analysed from the job log. The devnet chain is disposable.
  if (outcome === 'failure') {
    for (const [name, log] of Object.entries(validatorLogs)) {
      console.log(`::group::validator ${name} log (last 200 lines)`);
      console.log(log.split('\n').slice(-200).join('\n'));
      console.log('::endgroup::');
    }
  }
  if (result.kind === 'regression') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
