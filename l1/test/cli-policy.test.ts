import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { enforceCanonicalCliSecurityPolicy } from "../src/cli-policy.js";
import { isEncryptedKeystore } from "../src/keystore.js";

const execFileAsync = promisify(execFile);
const cliPath = new URL("../src/cli.js", import.meta.url).pathname;
const secureCliPath = new URL("../src/secure-cli.js", import.meta.url).pathname;

async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileAsync(process.execPath, [cliPath, ...args], {
    env,
    maxBuffer: 1024 * 1024
  });
}

async function runSecureCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return execFileAsync(process.execPath, [secureCliPath, ...args], {
    env,
    maxBuffer: 1024 * 1024
  });
}

test("published secure CLI refuses new plaintext private-key generation before output creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-secure-keygen-policy-"));
  const output = join(root, "wallet.json");
  try {
    await assert.rejects(runSecureCli(["keygen", "--out", output]), /requires --password-file/);
    await assert.rejects(readFile(output, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical CLI refuses new plaintext private-key generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-keygen-policy-"));
  const output = join(root, "wallet.json");
  try {
    await assert.rejects(runCli(["keygen", "--out", output]), /requires --password-file/);
    await assert.rejects(readFile(output, "utf8"), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical CLI creates an encrypted keystore when the private password file is supplied", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-encrypted-keygen-"));
  const output = join(root, "wallet.json");
  const password = join(root, "wallet.password");
  try {
    await writeFile(password, "a-strong-local-wallet-password\n", { mode: 0o600 });
    await runCli(["keygen", "--out", output, "--password-file", password]);
    const parsed = JSON.parse(await readFile(output, "utf8")) as Record<string, unknown>;
    assert.equal(isEncryptedKeystore(parsed), true);
    assert.equal(Object.hasOwn(parsed, "privateKey"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical CLI rejects remote plaintext RPC before command execution", () => {
  assert.throws(
    () => enforceCanonicalCliSecurityPolicy(["transfer", "--rpc", "http://node.example:9137"]),
    /must use HTTPS/
  );
  assert.doesNotThrow(() => enforceCanonicalCliSecurityPolicy(["transfer", "--rpc", "http://127.0.0.1:9137"]));
  assert.doesNotThrow(() => enforceCanonicalCliSecurityPolicy(["transfer", "--rpc", "https://node.example:9137"]));
});

test("canonical CLI rejects group/other-readable secrets and existing node identities on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode bits are not authoritative on Windows");
  const root = await mkdtemp(join(tmpdir(), "zyron-cli-secret-mode-"));
  const secret = join(root, "wallet.password");
  const identity = join(root, "node-identity.json");
  try {
    await writeFile(secret, "a-strong-local-wallet-password\n", { mode: 0o600 });
    assert.doesNotThrow(() => enforceCanonicalCliSecurityPolicy(["keygen", "--out", join(root, "wallet.json"), "--password-file", secret]));
    await chmod(secret, 0o644);
    assert.throws(
      () => enforceCanonicalCliSecurityPolicy(["keygen", "--out", join(root, "wallet.json"), "--password-file", secret]),
      /group\/other users/
    );

    await writeFile(identity, "{}\n", { mode: 0o644 });
    assert.throws(
      () => enforceCanonicalCliSecurityPolicy(["node", "--data", root]),
      /node identity.*group\/other users/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("canonical CLI rejects symbolic-link secret paths", async (t) => {
  if (process.platform === "win32") return t.skip("symbolic-link creation may require elevated Windows privileges");
  const root = await mkdtemp(join(tmpdir(), "zyron-cli-secret-link-"));
  const target = join(root, "wallet.password.real");
  const link = join(root, "wallet.password");
  try {
    await writeFile(target, "a-strong-local-wallet-password\n", { mode: 0o600 });
    await symlink(target, link);
    assert.throws(
      () => enforceCanonicalCliSecurityPolicy(["keygen", "--out", join(root, "wallet.json"), "--password-file", link]),
      /must not reference a symbolic link/
    );
    assert.throws(
      () => enforceCanonicalCliSecurityPolicy(["node", "--data", root, "--validator-signer-token-file", link, "--validator-signer-url", "https:\/\/signer.example", "--validator-public-key", "11".repeat(64)]),
      /must not reference a symbolic link/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
