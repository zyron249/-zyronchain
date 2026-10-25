import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Backlog P1-04: the protocol-v1 `local-devnet` job is informational and its
// result is classified; the protocol-v6 job is the candidate required check.
// These tests pin that the classifier only explains results (it never turns a
// failure into a pass), that only the full F-01 stall signature (a bare known
// timeout, both validators agreeing at height H, the v1 round-skip quorum
// failing at H+1 in both validator logs) counts as the known flake, and that
// neither devnet job is allowed to swallow failures.

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = join(l1Root, "..");
const script = join(l1Root, "scripts/classify-devnet-v1-result.mjs");

type Result = { kind: string; level: string; title: string; message: string; error?: string | null };
type Logs = Record<string, string>;
type Classifier = {
  KNOWN_V1_FLAKE_MESSAGES: readonly string[];
  classifyDevnetV1Result(text: string, outcome: string, validatorLogs?: Logs): Result;
  annotation(result: Result): string;
};
const load = async (): Promise<Classifier> => import(new URL("../../scripts/classify-devnet-v1-result.mjs", import.meta.url).href) as Promise<Classifier>;

const node = (height: number, tip = "aa") => ({ chainId: "zyron-local-1", genesisHash: "gg", height, tipHash: tip });
const status = (a: object, b: object) => JSON.stringify([a, b]);
const stalled = status(node(1), node(1));
const passLog = 'Transfer verified on both validators at height 2.\n{\n  "ok": true,\n  "quorumVerified": true,\n  "restartVerified": true\n}\n';
const failLog = (stack: string, dir = "/tmp/zyron-local-devnet-x") => `Waiting for both validators to finalize a block (30-second block interval)...\n${stack}\n    at waitFor (file:///x/l1/scripts/local-devnet.mjs:129:9)\nDevelopment data retained at ${dir}; it contains development-only encrypted keys and password files.\n`;
// Validator logs as written by the harness when v1 stalls (shape copied from CI).
const skipLine = (height: number, votes = "1/2") => `2026-10-16T16:46:07.954Z Round skip certificate incomplete: height=${height} round=0 protocolVersion=1 error=Round skip quorum not reached: ${votes}`;
const stallLogs = (height: number): Logs => ({
  a: `2026-10-16T16:44:08.031Z Finalized block ${height} 79ff\n${skipLine(height + 1)}\n${skipLine(height + 1)}\n`,
  b: `2026-10-16T16:43:37.927Z Node ID c0a4\n${skipLine(height + 1)}\n`
});

test("P1-04 classifier: only the full protocol-v1 F-01 stall signature is the known flake", async () => {
  const { classifyDevnetV1Result, KNOWN_V1_FLAKE_MESSAGES } = await load();
  assert.deepEqual([...KNOWN_V1_FLAKE_MESSAGES], [
    "Timed out: transfer finalized by both validators",
    "Timed out: finality resumes after validator restart"
  ]);
  for (const [stack, height] of [
    [`Error: Timed out: transfer finalized by both validators last-status=${stalled}`, 1],
    [`Error: Timed out: finality resumes after validator restart (fetch failed) last-status=${status(node(2, "bb"), node(2, "bb"))}`, 2]
  ] as const) {
    const result = classifyDevnetV1Result(failLog(stack), "failure", stallLogs(height));
    assert.equal(result.kind, "known-flake", stack);
    assert.equal(result.level, "warning");
    assert.match(result.message, /docs\/L1_TEST_RELIABILITY\.md/);
    assert.match(result.message, /local-devnet-v6/);
  }
  const regressions: Array<[string, Logs | undefined]> = [
    // A wrapped assertion inside the transfer wait (wrong sender balance / nonce).
    [`Error: Timed out: transfer finalized by both validators (Expected values to be strictly equal:\n\n99899998000 !== 99899999000\n) last-status=${stalled}`, stallLogs(1)],
    [`Error: Timed out: transfer finalized by both validators (Expected values to be strictly equal: 2 !== 1) last-status=${stalled}`, stallLogs(1)],
    // The chain kept finalizing (e.g. receiver balance wrong): no stall at H+1.
    [`Error: Timed out: transfer finalized by both validators last-status=${status(node(5), node(5))}`, { a: "Finalized block 5 aa\n", b: "Finalized block 4 aa\n" }],
    [`Error: Timed out: transfer finalized by both validators last-status=${stalled}`, { a: `${skipLine(2)}\nFinalized block 3 cc\n`, b: `${skipLine(2)}\n` }],
    // Diverged or incomplete status.
    [`Error: Timed out: transfer finalized by both validators last-status=${status(node(1, "aa"), node(1, "bb"))}`, stallLogs(1)],
    [`Error: Timed out: transfer finalized by both validators last-status=${status(node(1), node(2))}`, stallLogs(1)],
    [`Error: Timed out: finality resumes after validator restart (fetch failed) last-status=${JSON.stringify([node(2), "fetch failed"])}`, stallLogs(2)],
    // Known label but no validator logs, or logs without the v1 round-skip failure.
    [`Error: Timed out: transfer finalized by both validators last-status=${stalled}`, undefined],
    [`Error: Timed out: transfer finalized by both validators last-status=${stalled}`, { a: "idle\n", b: "idle\n" }],
    // Other messages.
    ["AssertionError [ERR_ASSERTION]: One validator finalized without quorum", stallLogs(1)],
    [`Error: Timed out: both nodes replay persisted chain last-status=${stalled}`, stallLogs(1)],
    [`Error: Timed out: initial finality last-status=${stalled}`, stallLogs(1)],
    ["Error: Validator a exited unexpectedly: {\"code\":1,\"signal\":null}", stallLogs(1)],
    ["Error: transfer rejected: insufficient balance; Timed out: transfer finalized by both validators", stallLogs(1)]
  ];
  for (const [stack, logs] of regressions) {
    const result = classifyDevnetV1Result(failLog(stack), "failure", logs);
    assert.equal(result.kind, "regression", stack);
    assert.equal(result.level, "error");
  }
  assert.equal(classifyDevnetV1Result("", "failure", stallLogs(1)).kind, "regression", "a failure without an error message is not the known flake");
});

test("P1-04 classifier: a pass needs the devnet summary and other outcomes are reported, never upgraded", async () => {
  const { classifyDevnetV1Result, annotation } = await load();
  const pass = classifyDevnetV1Result(passLog, "success");
  assert.equal(pass.kind, "pass");
  assert.equal(pass.level, "notice");
  assert.equal(classifyDevnetV1Result("Transfer verified on both validators at height 2.\n", "success").kind, "regression");
  for (const outcome of ["skipped", "cancelled"]) assert.equal(classifyDevnetV1Result("", outcome).kind, "not-run");
  const line = annotation(classifyDevnetV1Result(failLog(`Error: Timed out: transfer finalized by both validators last-status=${stalled}\nsecond line`), "failure", stallLogs(1)));
  assert.match(line, /^::warning title=[^:\n]+::/);
  assert.equal(line.includes("\n"), false);
});

test("P1-04 classifier CLI: reads the retained validator logs; exits non-zero for a regression, zero for the known flake and a pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-devnet-classify-"));
  try {
    const chain = join(dir, "zyron-local-devnet-x");
    await mkdir(chain);
    const logs = stallLogs(1);
    await writeFile(join(chain, "a.log"), logs.a ?? "");
    await writeFile(join(chain, "b.log"), logs.b ?? "");
    let count = 0;
    const run = async (text: string, outcome: string) => {
      count += 1;
      const path = join(dir, `run-${count}.log`);
      await writeFile(path, text);
      return spawnSync(process.execPath, [script, path, outcome], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md") } });
    };
    const flake = await run(failLog(`Error: Timed out: transfer finalized by both validators last-status=${stalled}`, chain), "failure");
    assert.equal(flake.status, 0, flake.stderr);
    assert.match(flake.stdout, /^::warning title=Known protocol-v1 flake \(F-01\)/m);
    assert.match(flake.stdout, /^::group::validator a log \(last 200 lines\)$/m);
    assert.match(flake.stdout, /Round skip quorum not reached: 1\/2/);
    const noLogs = await run(failLog(`Error: Timed out: transfer finalized by both validators last-status=${stalled}`, join(dir, "missing")), "failure");
    assert.equal(noLogs.status, 1, "without validator logs the stall cannot be confirmed");
    const regression = await run(failLog("AssertionError [ERR_ASSERTION]: One validator finalized without quorum", chain), "failure");
    assert.equal(regression.status, 1);
    assert.match(regression.stdout, /^::error title=Protocol-v1 devnet%3A NOT the known F-01 flake::/m);
    const pass = await run(passLog, "success");
    assert.equal(pass.status, 0, pass.stderr);
    assert.match(pass.stdout, /^::notice /m);
    const summary = await readFile(join(dir, "summary.md"), "utf8");
    assert.match(summary, /local-devnet \(protocol v1, informational\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function jobBlock(workflow: string, id: string): string {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`  ${id}:`);
  assert.ok(start >= 0, `job ${id} missing`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[index] ?? "")) { end = index; break; }
  }
  return lines.slice(start, end).join("\n");
}

test("P1-04 workflow: both devnet jobs run the unmodified checks and neither swallows a failure", async () => {
  const workflow = await readFile(join(repoRoot, ".github/workflows/l1.yml"), "utf8");
  const v1 = jobBlock(workflow, "local-devnet");
  const v6 = jobBlock(workflow, "local-devnet-v6");
  for (const block of [v1, v6]) {
    assert.equal(/continue-on-error/.test(block), false, "devnet jobs must not use continue-on-error");
    assert.match(block, /timeout-minutes: 10\n/);
  }
  assert.match(v1, /name: local-devnet \(protocol v1, informational, known F-01 flake\)/);
  assert.match(v1, /shell: bash\n\s+run: npm run devnet:check:v1-legacy 2>&1 \| tee "\$RUNNER_TEMP\/local-devnet-v1\.log"\n/);
  assert.match(v1, /if: always\(\)\n[\s\S]*run: node scripts\/classify-devnet-v1-result\.mjs/);
  assert.match(v6, /run: npm run devnet:check:v6\n/);
  assert.equal(/^    name:/m.test(v6), false, "the v6 job keeps its id as the check name (candidate required check)");
  const launcher = await readFile(join(l1Root, "scripts/local-devnet.mjs"), "utf8");
  assert.ok(launcher.includes("waitFor('transfer finalized by both validators'"));
  assert.ok(launcher.includes("waitFor('finality resumes after validator restart'"));
  const docs = await readFile(join(repoRoot, "docs/L1_TEST_RELIABILITY.md"), "utf8");
  for (const message of ["Timed out: transfer finalized by both validators", "Timed out: finality resumes after validator restart"]) {
    assert.ok(docs.includes(message), `docs must list ${message}`);
  }
});
