import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { CLI_CHECKPOINT_SNAPSHOT_MAX_BYTES, CLI_GENESIS_MAX_BYTES } from "../src/cli-recovery-file.js";

const execFileAsync = promisify(execFile);
const directCli = fileURLToPath(new URL("../src/cli.js", import.meta.url));

async function expectDirectCliFailure(args: string[], pattern: RegExp): Promise<void> {
  await assert.rejects(
    () => execFileAsync(process.execPath, [directCli, ...args], { timeout: 10_000 }),
    (error: unknown) => {
      const record = error as { stderr?: string; killed?: boolean };
      assert.notEqual(record.killed, true, "direct legacy CLI must fail before timeout termination");
      assert.match(record.stderr ?? "", pattern);
      return true;
    }
  );
}

test("direct legacy CLI recovery and node-state commands use bounded recovery readers", async () => {
  const source = await readFile(new URL("../../src/cli.ts", import.meta.url), "utf8");
  assert.equal(source.includes('readFile(resolve(genesisPath), "utf8")'), false);
  assert.equal(source.includes('readFile(resolve(snapshotPath), "utf8")'), false);
  assert.equal((source.match(/readCliGenesisUtf8\(resolve\(genesisPath\)\)/g) ?? []).length, 6);
  assert.match(source, /readCliCheckpointSnapshotAnchoredUtf8\(resolve\(snapshotPath\), snapshotSha256\)/);
});

test("direct legacy CLI rejects oversized genesis before command state work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-direct-cli-genesis-"));
  try {
    const genesis = join(dir, "genesis.json");
    await writeFile(genesis, "");
    await truncate(genesis, CLI_GENESIS_MAX_BYTES + 1);
    await expectDirectCliFailure(
      ["snapshot", "--genesis", genesis, "--data", join(dir, "data"), "--out", join(dir, "out.json")],
      /CLI genesis file exceeds (?:.* byte limit|byte bounds)/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct legacy CLI rejects oversized checkpoint before full materialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-direct-cli-checkpoint-bound-"));
  try {
    const genesis = join(dir, "genesis.json");
    const snapshot = join(dir, "checkpoint.json");
    await writeFile(genesis, "{}\n");
    await writeFile(snapshot, "");
    await truncate(snapshot, CLI_CHECKPOINT_SNAPSHOT_MAX_BYTES + 1);
    await expectDirectCliFailure(
      [
        "checkpoint-install", "--genesis", genesis, "--snapshot", snapshot, "--data", join(dir, "data"),
        "--tip-hash", "0".repeat(64), "--sha256", "0".repeat(64)
      ],
      /CLI checkpoint snapshot exceeds .* byte limit/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct legacy CLI rejects wrong checkpoint digest before structural parsing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-direct-cli-checkpoint-digest-"));
  try {
    const genesis = join(dir, "genesis.json");
    const snapshot = join(dir, "checkpoint.json");
    await writeFile(genesis, "{}\n");
    await writeFile(snapshot, `${"[".repeat(65)}0${"]".repeat(65)}`);
    await expectDirectCliFailure(
      [
        "checkpoint-install", "--genesis", genesis, "--snapshot", snapshot, "--data", join(dir, "data"),
        "--tip-hash", "0".repeat(64), "--sha256", "0".repeat(64)
      ],
      /CLI checkpoint snapshot SHA-256 mismatch/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
