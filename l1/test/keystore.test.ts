import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { generatePrivateKey } from "../src/crypto.js";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  isEncryptedKeystore,
  normalizePasswordFile,
  zeroizeSecretBuffer
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

test("mutable keystore secret buffers are explicitly zeroized", () => {
  const secret = Buffer.from("operation-scoped-secret", "utf8");
  zeroizeSecretBuffer(secret);
  assert.equal(secret.equals(Buffer.alloc(secret.length)), true);
});

test("keystore encryption and decryption wire zeroization through finally paths", () => {
  const source = readFileSync(resolve(process.cwd(), "src/keystore.ts"), "utf8");
  const encryptStart = source.indexOf("export function encryptPrivateKey");
  const decryptStart = source.indexOf("export function decryptPrivateKey");
  const encryptedPredicateStart = source.indexOf("export function isEncryptedKeystore");
  assert.ok(encryptStart >= 0 && decryptStart > encryptStart && encryptedPredicateStart > decryptStart);

  const encryptSource = source.slice(encryptStart, decryptStart);
  const decryptSource = source.slice(decryptStart, encryptedPredicateStart);
  assert.match(encryptSource, /finally\s*\{[\s\S]*zeroizeSecretBuffer\(privateKeyBytes\)[\s\S]*zeroizeSecretBuffer\(key\)/);
  assert.match(decryptSource, /finally\s*\{\s*zeroizeSecretBuffer\(privateKeyBytes\);\s*\}/);
  assert.match(decryptSource, /finally\s*\{\s*zeroizeSecretBuffer\(key\);\s*\}/);
});
