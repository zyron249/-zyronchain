import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  CLI_GOVERNANCE_ARTIFACT_MAX_BYTES,
  readCliGovernanceArtifactUtf8
} from "../src/cli-governance-file.js";

const execFileAsync = promisify(execFile);

test("CLI governance artifact reader accepts exact byte boundary and rejects oversized input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-governance-bound-"));
  try {
    const exact = join(dir, "exact.json");
    const oversized = join(dir, "oversized.json");
    await writeFile(exact, "x".repeat(CLI_GOVERNANCE_ARTIFACT_MAX_BYTES));
    await writeFile(oversized, "x".repeat(CLI_GOVERNANCE_ARTIFACT_MAX_BYTES + 1));
    assert.equal((await readCliGovernanceArtifactUtf8(exact)).length, CLI_GOVERNANCE_ARTIFACT_MAX_BYTES);
    await assert.rejects(() => readCliGovernanceArtifactUtf8(oversized), /exceeds .* byte limit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI governance artifact reader rejects POSIX symlink substitution", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-governance-symlink-"));
  try {
    const target = join(dir, "proposal.json");
    const link = join(dir, "proposal-link.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);
    await assert.rejects(() => readCliGovernanceArtifactUtf8(link), /symbolic link/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("published governance entrypoint rejects a symlink proposal before key access", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-governance-entry-"));
  try {
    const target = join(dir, "proposal.json");
    const link = join(dir, "proposal-link.json");
    await writeFile(target, "{}\n");
    await symlink(target, link);
    const entry = fileURLToPath(new URL("../src/secure-cli.js", import.meta.url));
    await assert.rejects(
      () => execFileAsync(process.execPath, [entry, "validator-approve", "--proposal", link, "--key", join(dir, "missing-key.json"), "--out", join(dir, "approval.json")], { timeout: 5_000 }),
      (error: unknown) => {
        const record = error as { stderr?: string; killed?: boolean };
        assert.notEqual(record.killed, true);
        assert.match(record.stderr ?? "", /CLI governance artifact must not be a symbolic link/);
        return true;
      }
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("secure CLI stages every repeated governance approval input", async () => {
  const source = await readFile(new URL("../src/secure-cli.ts", import.meta.url), "utf8");
  assert.match(source, /stageRepeated\(args, "--approval"/);
  assert.match(source, /"validator-submit"/);
  assert.match(source, /"protocol-submit"/);
});
