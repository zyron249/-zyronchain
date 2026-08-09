import assert from "node:assert/strict";
import test from "node:test";

import { generatePrivateKey } from "../src/crypto.js";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  isEncryptedKeystore,
  normalizePasswordFile
} from "../src/keystore.js";

test("encrypted keystore round-trips without storing plaintext private-key material", () => {
  const privateKey = generatePrivateKey();
  const password = "correct horse battery staple";
  const keystore = encryptPrivateKey(privateKey, password);

  assert.equal(isEncryptedKeystore(keystore), true);
  assert.equal(JSON.stringify(keystore).includes(privateKey), false);
  assert.equal(decryptPrivateKey(keystore, password), privateKey);
});

test("encrypted keystore rejects wrong passwords and authenticated-field substitution", () => {
  const privateKey = generatePrivateKey();
  const keystore = encryptPrivateKey(privateKey, "a sufficiently long password");

  assert.throws(
    () => decryptPrivateKey(keystore, "another sufficiently long password"),
    /authentication failed/
  );
  assert.throws(
    () => decryptPrivateKey({ ...keystore, address: `ZYN${"0".repeat(40)}` }, "a sufficiently long password"),
    /authentication failed/
  );
  assert.throws(
    () => decryptPrivateKey({ ...keystore, extra: true }, "a sufficiently long password"),
    /unexpected fields/
  );
});

test("password files are bounded, single-line secrets", () => {
  assert.equal(normalizePasswordFile("twelve-characters-or-more\n"), "twelve-characters-or-more");
  assert.equal(normalizePasswordFile("twelve-characters-or-more\r\n"), "twelve-characters-or-more");
  assert.throws(() => normalizePasswordFile("too-short"), /at least 12/);
  assert.throws(() => normalizePasswordFile("long-enough\nsecond-line"), /forbidden characters/);
  assert.throws(() => normalizePasswordFile("x".repeat(1_025)), /too large/);
});
