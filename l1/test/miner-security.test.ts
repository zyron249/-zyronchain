import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encryptPrivateKey } from "../src/keystore.js";
import { loadEncryptedMinerPrivateKey } from "../src/miner-security.js";

const PRIVATE_KEY = "1".padStart(64, "0");
const PASSWORD = "correct-horse-battery-staple";

test("standalone miner loads an owner-only encrypted keystore", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-miner-key-"));
  const keyPath = join(root, "wallet.json");
  const passwordPath = join(root, "wallet.password");
  try {
    await writeFile(keyPath, `${JSON.stringify(encryptPrivateKey(PRIVATE_KEY, PASSWORD))}\n`, { mode: 0o600 });
    await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });
    assert.equal(await loadEncryptedMinerPrivateKey(keyPath, passwordPath), PRIVATE_KEY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone miner rejects legacy plaintext private-key JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-miner-plaintext-"));
  const keyPath = join(root, "wallet.json");
  const passwordPath = join(root, "wallet.password");
  try {
    await writeFile(keyPath, `${JSON.stringify({ privateKey: PRIVATE_KEY })}\n`, { mode: 0o600 });
    await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });
    await assert.rejects(
      loadEncryptedMinerPrivateKey(keyPath, passwordPath),
      /requires an encrypted ZyronChain keystore; plaintext private-key files are not accepted/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone miner rejects group or world-accessible secret files on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX mode bits are not authoritative on Windows");
  const root = await mkdtemp(join(tmpdir(), "zyron-miner-mode-"));
  const keyPath = join(root, "wallet.json");
  const passwordPath = join(root, "wallet.password");
  try {
    await writeFile(keyPath, `${JSON.stringify(encryptPrivateKey(PRIVATE_KEY, PASSWORD))}\n`, { mode: 0o600 });
    await writeFile(passwordPath, `${PASSWORD}\n`, { mode: 0o600 });

    await chmod(keyPath, 0o644);
    await assert.rejects(loadEncryptedMinerPrivateKey(keyPath, passwordPath), /Miner keystore must not be readable/);

    await chmod(keyPath, 0o600);
    await chmod(passwordPath, 0o640);
    await assert.rejects(loadEncryptedMinerPrivateKey(keyPath, passwordPath), /Miner password file must not be readable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone miner rejects symlinked keystore and password paths", async (t) => {
  if (process.platform === "win32") return t.skip("symbolic-link creation may require elevated Windows privileges");
  const root = await mkdtemp(join(tmpdir(), "zyron-miner-symlink-"));
  const realKey = join(root, "real-wallet.json");
  const realPassword = join(root, "real-wallet.password");
  const keyLink = join(root, "wallet.json");
  const passwordLink = join(root, "wallet.password");
  try {
    await writeFile(realKey, `${JSON.stringify(encryptPrivateKey(PRIVATE_KEY, PASSWORD))}\n`, { mode: 0o600 });
    await writeFile(realPassword, `${PASSWORD}\n`, { mode: 0o600 });
    await symlink(realKey, keyLink);
    await symlink(realPassword, passwordLink);

    await assert.rejects(loadEncryptedMinerPrivateKey(keyLink, realPassword), /Miner keystore must not be a symbolic link/);
    await assert.rejects(loadEncryptedMinerPrivateKey(realKey, passwordLink), /Miner password file must not be a symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
