import assert from "node:assert/strict";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import test from "node:test";

import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  decryptPrivateKey,
  encryptPrivateKey,
  isEncryptedKeystore,
  keystoreVersion,
  KEYSTORE_V1_SCRYPT,
  KEYSTORE_V2_SCRYPT,
  migrateKeystore
} from "../src/keystore.js";

const PASSWORD = "a sufficiently long keystore password";

// Produced by the released v1 code (main 7465861, l1/src/keystore.ts) for private key 0x7b.
const LEGACY_V1 = {
  version: 1,
  kdf: "scrypt",
  cipher: "aes-256-gcm",
  salt: "59892c3f19041bcfdb5d5886832a0f29b251a0248bce7c0c6b9d2bb9c5cd74a6",
  iv: "c26057b446e0fe605094f884",
  tag: "ad3869d3cb2ea3aa68b648d9362ac038",
  ciphertext: "6eacfe3883bb825d7616beac6b3018b6b9dc8e6e96247b26e5ba90c1b43a4d72fccd9c72595bf82b73bf994acb180c332bdaa62de5da756271e47340783b409d",
  publicKey: "a598a8030da6d86c6bc7f2f5144ea549d28211ea58faa70ebf4c1e665c1fe9b5204b5d6f84822c307e4b4a7140737aec23fc63b65b35f86a10026dbd2d864e6b",
  address: "ZYN80636eaa7a0a54ad4e369e0b6c6f08ead6a49448"
};
const LEGACY_V1_PASSWORD = "legacy v1 keystore password";
const LEGACY_V1_PRIVATE_KEY = "7b".padStart(64, "0");

// Independent v1 encoder written from the documented format (not the library code).
function independentV1(privateKey: string, password: string) {
  const publicKey = publicKeyFromPrivate(privateKey);
  const address = addressFromPublicKey(publicKey);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(password, salt, 32, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`zyronchain/local-keystore/v1\n${publicKey}\n${address}`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey, "utf8")), cipher.final()]);
  return {
    version: 1, kdf: "scrypt", cipher: "aes-256-gcm", salt: salt.toString("hex"), iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex"), publicKey, address
  };
}

const flip = (hex: string) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);

test("new keystores are v2 with scrypt N=2^17, r=8, p=1 and round-trip", () => {
  assert.deepEqual({ ...KEYSTORE_V2_SCRYPT }, { n: 131_072, r: 8, p: 1, dkLen: 32 });
  assert.deepEqual({ ...KEYSTORE_V1_SCRYPT }, { n: 32_768, r: 8, p: 1, dkLen: 32 });
  const privateKey = generatePrivateKey();
  const first = encryptPrivateKey(privateKey, PASSWORD);
  const second = encryptPrivateKey(privateKey, PASSWORD);
  assert.equal(first.version, 2);
  assert.deepEqual(first.kdfParams, { n: 131_072, r: 8, p: 1, dkLen: 32 });
  assert.equal(isEncryptedKeystore(first), true);
  assert.equal(keystoreVersion(first), 2);
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.iv, second.iv);
  assert.equal(JSON.stringify(first).includes(privateKey), false);
  assert.equal(decryptPrivateKey(first, PASSWORD), privateKey);
  assert.equal(decryptPrivateKey(JSON.parse(JSON.stringify(second)), PASSWORD), privateKey);
});

test("legacy v1 keystores still decrypt (released vector and an independent encoder)", () => {
  assert.equal(isEncryptedKeystore(LEGACY_V1), true);
  assert.equal(keystoreVersion(LEGACY_V1), 1);
  assert.equal(decryptPrivateKey(LEGACY_V1, LEGACY_V1_PASSWORD), LEGACY_V1_PRIVATE_KEY);
  const privateKey = generatePrivateKey();
  assert.equal(decryptPrivateKey(independentV1(privateKey, PASSWORD), PASSWORD), privateKey);
  assert.throws(() => decryptPrivateKey(LEGACY_V1, PASSWORD), /authentication failed/);
});

test("v1 -> v2 migration keeps the identity, uses fresh salt/IV and requires the password", () => {
  const migrated = migrateKeystore(LEGACY_V1, LEGACY_V1_PASSWORD);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.address, LEGACY_V1.address);
  assert.equal(migrated.publicKey, LEGACY_V1.publicKey);
  assert.notEqual(migrated.salt, LEGACY_V1.salt);
  assert.equal(decryptPrivateKey(migrated, LEGACY_V1_PASSWORD), LEGACY_V1_PRIVATE_KEY);
  assert.throws(() => migrateKeystore(LEGACY_V1, "not the legacy password"), /authentication failed/);
  const again = migrateKeystore(migrated, LEGACY_V1_PASSWORD);
  assert.notEqual(again.salt, migrated.salt);
  assert.throws(() => migrateKeystore({ ...LEGACY_V1, ciphertext: flip(LEGACY_V1.ciphertext) }, LEGACY_V1_PASSWORD), /authentication failed/);
});

test("v2 tamper detection: every authenticated field, identity substitution and wrong password fail", () => {
  const privateKey = generatePrivateKey();
  const keystore = encryptPrivateKey(privateKey, PASSWORD);
  for (const field of ["ciphertext", "tag", "iv", "salt"] as const) {
    assert.throws(() => decryptPrivateKey({ ...keystore, [field]: flip(keystore[field]) }, PASSWORD), /authentication failed/, field);
  }
  const other = publicKeyFromPrivate(generatePrivateKey());
  assert.throws(() => decryptPrivateKey({ ...keystore, publicKey: other, address: addressFromPublicKey(other) }, PASSWORD), /authentication failed/);
  assert.throws(() => decryptPrivateKey(keystore, "wrong but long password"), /authentication failed/);
});

test("v2 refuses KDF downgrades, attacker-chosen costs and version confusion before scrypt", () => {
  const keystore = encryptPrivateKey(generatePrivateKey(), PASSWORD);
  for (const kdfParams of [
    { n: 32_768, r: 8, p: 1, dkLen: 32 },
    { n: 1_048_576, r: 8, p: 1, dkLen: 32 },
    { n: 131_072, r: 8, p: 2, dkLen: 32 },
    { n: 131_072, r: 8, p: 1 },
    { n: 131_072, r: 8, p: 1, dkLen: 32, extra: 1 }
  ]) {
    assert.throws(() => decryptPrivateKey({ ...keystore, kdfParams }, PASSWORD), /kdfParams are unsupported/);
  }
  // Relabelling a v2 keystore as v1 (dropping kdfParams) must not decrypt: the AAD binds the version.
  const { kdfParams: _dropped, ...rest } = keystore;
  assert.throws(() => decryptPrivateKey({ ...rest, version: 1 }, PASSWORD), /authentication failed/);
  // v1 with a kdfParams field is malformed.
  assert.throws(() => decryptPrivateKey({ ...LEGACY_V1, kdfParams: keystore.kdfParams }, LEGACY_V1_PASSWORD), /unexpected fields/);
  assert.throws(() => decryptPrivateKey({ ...keystore, version: 3 }, PASSWORD), /unsupported/);
});
