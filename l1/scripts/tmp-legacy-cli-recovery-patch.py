from pathlib import Path

root = Path(__file__).resolve().parents[1]
repo = root.parent
cli_path = root / "src" / "cli.ts"
cli = cli_path.read_text(encoding="utf-8")

import_anchor = 'import { readPrivateRegularFile } from "./local-security.js";\n'
import_line = 'import { readCliCheckpointSnapshotAnchoredUtf8, readCliGenesisUtf8 } from "./cli-recovery-file.js";\n'
if import_line not in cli:
    if import_anchor not in cli:
        raise RuntimeError("legacy CLI import anchor not found")
    cli = cli.replace(import_anchor, import_anchor + import_line, 1)

raw_genesis = 'JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig'
bounded_genesis = 'JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig'
count = cli.count(raw_genesis)
if count != 6:
    raise RuntimeError(f"expected 6 raw recovery/node genesis reads, found {count}")
cli = cli.replace(raw_genesis, bounded_genesis)

raw_snapshot = 'JSON.parse(await readFile(resolve(snapshotPath), "utf8")) as unknown'
bounded_snapshot = 'JSON.parse(await readCliCheckpointSnapshotAnchoredUtf8(resolve(snapshotPath), snapshotSha256)) as unknown'
if cli.count(raw_snapshot) != 1:
    raise RuntimeError("expected one raw checkpoint snapshot read")
cli = cli.replace(raw_snapshot, bounded_snapshot, 1)

if 'readFile(resolve(genesisPath), "utf8")' in cli:
    raise RuntimeError("raw genesis read remains in legacy CLI")
if 'readFile(resolve(snapshotPath), "utf8")' in cli:
    raise RuntimeError("raw checkpoint snapshot read remains in legacy CLI")
cli_path.write_text(cli, encoding="utf-8")

(repo / "docs" / "LEGACY_CLI_RECOVERY_CUSTODY.md").write_text("""# Legacy CLI recovery file custody

The published `zyron-l1` entrypoint continues to stage operator-controlled recovery files through `secure-cli`. Direct invocation of the compiled legacy CLI is defense-in-depth hardened as well.

Recovery and node-state commands read `--genesis` through the same bounded descriptor/path-custody reader. Direct `checkpoint-install` reads `--snapshot` through the SHA-256-anchored bounded checkpoint reader before structural scanning and JSON parsing. This preserves the 256 KiB genesis ceiling, 64 MiB checkpoint ceiling, canonical-path freeze, post-open/post-read revalidation, POSIX no-follow/non-blocking behavior, digest-before-parse ordering, and checkpoint JSON complexity gate.

Published secure staging remains the supported entrypoint and is not bypassed or weakened by this additional layer. Semantic checkpoint validation, finalized-history/governance/State-v2 checks, consensus/finality, validator key custody, mining/rewards, and every public-mining/public-testnet/mainnet activation gate remain unchanged. This local integrity/availability hardening does not satisfy target-hardware recovery evidence.
""", encoding="utf-8")

(root / "test" / "legacy-cli-recovery-custody.test.ts").write_text(r'''import assert from "node:assert/strict";
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
    await truncate(genesis, CLI_GENESIS_MAX_BYTES + 1);
    await expectDirectCliFailure(
      ["snapshot", "--genesis", genesis, "--data", join(dir, "data"), "--out", join(dir, "out.json")],
      /CLI genesis file exceeds .* byte limit/
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
''', encoding="utf-8")
