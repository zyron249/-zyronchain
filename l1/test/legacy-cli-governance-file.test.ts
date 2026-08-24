import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
import { CLI_GOVERNANCE_ARTIFACT_MAX_BYTES } from "../src/cli-governance-file.js";

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

async function writePrivateKeyFile(path: string): Promise<void> {
  const privateKey = generatePrivateKey();
  await writeFile(path, JSON.stringify({ privateKey }), { mode: 0o600 });
}

test("legacy governance readers all use the bounded governance artifact reader", async () => {
  const source = await readFile(new URL("../../src/cli.ts", import.meta.url), "utf8");
  assert.equal(source.includes('JSON.parse(await readFile(path, "utf8"))'), false);
  assert.equal((source.match(/JSON\.parse\(await readCliGovernanceArtifactUtf8\(path\)\)/g) ?? []).length, 3);
});

test("direct legacy validator-approve rejects oversized proposal before key access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-direct-governance-proposal-"));
  try {
    const proposal = join(dir, "proposal.json");
    const key = join(dir, "key.json");
    await writePrivateKeyFile(key);
    await writeFile(proposal, "");
    await truncate(proposal, CLI_GOVERNANCE_ARTIFACT_MAX_BYTES + 1);
    await expectDirectCliFailure(
      ["validator-approve", "--proposal", proposal, "--key", key, "--out", join(dir, "approval.json")],
      /CLI governance artifact exceeds .*byte/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct legacy validator-submit rejects oversized approval before RPC work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-direct-governance-approval-"));
  try {
    const privateKey = generatePrivateKey();
    const publicKey = publicKeyFromPrivate(privateKey);
    const sender = addressFromPublicKey(publicKey);
    const key = join(dir, "key.json");
    const proposal = join(dir, "proposal.json");
    const approval = join(dir, "approval.json");
    await writeFile(key, JSON.stringify({ privateKey }), { mode: 0o600 });
    await writeFile(proposal, JSON.stringify({
      transactionVersion: 1, chainId: "custody-test", nonce: 1, sender, activationHeight: 1, validators: []
    }));
    await writeFile(approval, "");
    await truncate(approval, CLI_GOVERNANCE_ARTIFACT_MAX_BYTES + 1);
    await expectDirectCliFailure(
      ["validator-submit", "--proposal", proposal, "--approval", approval, "--key", key, "--rpc", "http://127.0.0.1:1"],
      /CLI governance artifact exceeds .*byte/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("direct legacy governance proposal rejects symlink substitution on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("Windows junction/reparse coverage is exercised by the bounded-file security suite");
  const dir = await mkdtemp(join(tmpdir(), "zyron-direct-governance-symlink-"));
  try {
    const target = join(dir, "target.json");
    const link = join(dir, "proposal.json");
    const key = join(dir, "key.json");
    await writePrivateKeyFile(key);
    await writeFile(target, "{}\n");
    await symlink(target, link);
    await expectDirectCliFailure(
      ["validator-approve", "--proposal", link, "--key", key, "--out", join(dir, "approval.json")],
      /symbolic link|path changed|regular file/i
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
