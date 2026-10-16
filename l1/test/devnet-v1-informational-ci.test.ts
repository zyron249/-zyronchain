import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Backlog P1-04: the protocol-v1 `local-devnet` job is informational and its
// result is classified; the protocol-v6 job is the candidate required check.
// These tests pin that the classifier only explains results (it never turns a
// failure into a pass), that only the two known F-01 timeouts count as the
// known flake, and that neither devnet job is allowed to swallow failures.

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = join(l1Root, "..");
const script = join(l1Root, "scripts/classify-devnet-v1-result.mjs");

type Result = { kind: string; level: string; title: string; message: string; error?: string | null };
type Classifier = {
  KNOWN_V1_FLAKE_MESSAGES: readonly string[];
  classifyDevnetV1Result(text: string, outcome: string): Result;
  annotation(result: Result): string;
};
const load = async (): Promise<Classifier> => import(new URL("../../scripts/classify-devnet-v1-result.mjs", import.meta.url).href) as Promise<Classifier>;

const status = '[{"chainId":"zyron-local-1","height":1,"tipHash":"aa"},{"chainId":"zyron-local-1","height":1,"tipHash":"aa"}]';
const passLog = 'Transfer verified on both validators at height 2.\n{\n  "ok": true,\n  "quorumVerified": true,\n  "restartVerified": true\n}\n';
const failLog = (stack: string) => `Waiting for both validators to finalize a block (30-second block interval)...\n${stack}\n    at waitFor (file:///x/l1/scripts/local-devnet.mjs:129:9)\nDevelopment data retained at /tmp/zyron-local-devnet-x; it contains development-only encrypted keys and password files.\n`;

test("P1-04 classifier: only the two known protocol-v1 F-01 timeouts are the known flake", async () => {
  const { classifyDevnetV1Result, KNOWN_V1_FLAKE_MESSAGES } = await load();
  assert.deepEqual([...KNOWN_V1_FLAKE_MESSAGES], [
    "Timed out: transfer finalized by both validators",
    "Timed out: finality resumes after validator restart"
  ]);
  for (const stack of [
    `Error: Timed out: transfer finalized by both validators last-status=${status}`,
    `Error: Timed out: finality resumes after validator restart (fetch failed) last-status=${status}`
  ]) {
    const result = classifyDevnetV1Result(failLog(stack), "failure");
    assert.equal(result.kind, "known-flake", stack);
    assert.equal(result.level, "warning");
    assert.match(result.message, /docs\/L1_TEST_RELIABILITY\.md/);
    assert.match(result.message, /local-devnet-v6/);
  }
  for (const stack of [
    "AssertionError [ERR_ASSERTION]: One validator finalized without quorum",
    `Error: Timed out: both nodes replay persisted chain last-status=${status}`,
    `Error: Timed out: initial finality last-status=${status}`,
    "Error: Validator a exited unexpectedly: {\"code\":1,\"signal\":null}",
    "AssertionError [ERR_ASSERTION]: Validator b did not shut down cleanly",
    "Error: transfer rejected: insufficient balance; Timed out: transfer finalized by both validators"
  ]) {
    const result = classifyDevnetV1Result(failLog(stack), "failure");
    assert.equal(result.kind, "regression", stack);
    assert.equal(result.level, "error");
  }
  assert.equal(classifyDevnetV1Result("", "failure").kind, "regression", "a failure without an error message is not the known flake");
});

test("P1-04 classifier: a pass needs the devnet summary and other outcomes are reported, never upgraded", async () => {
  const { classifyDevnetV1Result, annotation } = await load();
  const pass = classifyDevnetV1Result(passLog, "success");
  assert.equal(pass.kind, "pass");
  assert.equal(pass.level, "notice");
  assert.equal(classifyDevnetV1Result("Transfer verified on both validators at height 2.\n", "success").kind, "regression");
  for (const outcome of ["skipped", "cancelled"]) assert.equal(classifyDevnetV1Result("", outcome).kind, "not-run");
  const line = annotation(classifyDevnetV1Result(failLog("Error: Timed out: transfer finalized by both validators\nsecond line"), "failure"));
  assert.match(line, /^::warning title=[^:\n]+::/);
  assert.equal(line.includes("\n"), false);
});

test("P1-04 classifier CLI: exits non-zero for a regression, zero for the known flake and a pass", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-devnet-classify-"));
  try {
    const run = async (text: string, outcome: string) => {
      const path = join(dir, `${outcome}-${text.length}.log`);
      await writeFile(path, text);
      return spawnSync(process.execPath, [script, path, outcome], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: join(dir, "summary.md") } });
    };
    const flake = await run(failLog(`Error: Timed out: transfer finalized by both validators last-status=${status}`), "failure");
    assert.equal(flake.status, 0, flake.stderr);
    assert.match(flake.stdout, /^::warning title=Known protocol-v1 flake \(F-01\)/m);
    const regression = await run(failLog("AssertionError [ERR_ASSERTION]: One validator finalized without quorum"), "failure");
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
  assert.match(v1, /shell: bash\n\s+run: npm run devnet:check 2>&1 \| tee "\$RUNNER_TEMP\/local-devnet-v1\.log"\n/);
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
