import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { encryptPrivateKey } from "../src/keystore.js";
import { readOperatorAuthToken, readOperatorPrivateKey } from "../src/operator-secrets.js";

const PRIVATE_KEY = "2".padStart(64, "0");
const PASSWORD = "operator-password-with-sufficient-length";
const TOKEN = "t".repeat(48);

test("operator secret reader loads plaintext and encrypted owner-only keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-operator-secret-"));
  const plain = join(root, "plain.json");
  const encrypted = join(root, "encrypted.json");
  const password = join(root, "password.txt");
  try {
    await writeFile(plain, `${JSON.stringify({ privateKey: PRIVATE_KEY })}\n`, { mode: 0o600 });
    await writeFile(encrypted, `${JSON.stringify(encryptPrivateKey(PRIVATE_KEY, PASSWORD))}\n`, { mode: 0o600 });
    await writeFile(password, `${PASSWORD}\n`, { mode: 0o600 });
    assert.equal(await readOperatorPrivateKey(plain), PRIVATE_KEY);
    assert.equal(await readOperatorPrivateKey(encrypted, password), PRIVATE_KEY);
    await assert.rejects(readOperatorPrivateKey(encrypted), /ZYRON_KEYSTORE_PASSWORD_FILE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plaintext validator key schema rejects extra top-level fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-operator-key-schema-"));
  const key = join(root, "key.json");
  try {
    await writeFile(key, `${JSON.stringify({ privateKey: PRIVATE_KEY, publicKey: "shadow" })}\n`, { mode: 0o600 });
    await assert.rejects(
      readOperatorPrivateKey(key),
      /must contain exactly privateKey/
    );

    await writeFile(key, `${JSON.stringify({ privateKey: PRIVATE_KEY })}\n`, { mode: 0o600 });
    assert.equal(await readOperatorPrivateKey(key), PRIVATE_KEY);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator auth token reader preserves format bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-operator-token-"));
  const token = join(root, "token.txt");
  try {
    await writeFile(token, `${TOKEN}\n`, { mode: 0o600 });
    assert.equal(await readOperatorAuthToken(token, "Peer"), TOKEN);
    await writeFile(token, "short\n", { mode: 0o600 });
    await assert.rejects(readOperatorAuthToken(token, "Peer"), /32-512 character token/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("operator secret readers reject permissive modes and symlinks on POSIX", async (t) => {
  if (process.platform === "win32") return t.skip("POSIX permissions and symlink behavior differ on Windows");
  const root = await mkdtemp(join(tmpdir(), "zyron-operator-secret-policy-"));
  const key = join(root, "key.json");
  const token = join(root, "token.txt");
  const keyLink = join(root, "key-link.json");
  const tokenLink = join(root, "token-link.txt");
  try {
    await writeFile(key, `${JSON.stringify({ privateKey: PRIVATE_KEY })}\n`, { mode: 0o600 });
    await writeFile(token, `${TOKEN}\n`, { mode: 0o600 });
    await symlink(key, keyLink);
    await symlink(token, tokenLink);
    await assert.rejects(readOperatorPrivateKey(keyLink), /symbolic link/);
    await assert.rejects(readOperatorAuthToken(tokenLink, "Peer"), /symbolic link/);

    await chmod(key, 0o640);
    await chmod(token, 0o644);
    await assert.rejects(readOperatorPrivateKey(key), /group\/other users/);
    await assert.rejects(readOperatorAuthToken(token, "Peer"), /group\/other users/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
