import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

import { addressFromPublicKey, publicKeyFromPrivate } from "./crypto.js";

const KEYSTORE_DOMAIN = "zyronchain/local-keystore/v1";
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export interface EncryptedKeystoreV1 {
  version: 1;
  kdf: "scrypt";
  cipher: "aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  publicKey: string;
  address: string;
}

/** @internal Zeroize mutable secret bytes once their operation-scoped lifetime ends. */
export function zeroizeSecretBuffer(buffer: Buffer): void {
  buffer.fill(0);
}

export function encryptPrivateKey(privateKey: string, password: string): EncryptedKeystoreV1 {
  assertPrivateKey(privateKey);
  assertPassword(password);
  const publicKey = publicKeyFromPrivate(privateKey);
  const address = addressFromPublicKey(publicKey);
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const privateKeyBytes = Buffer.from(privateKey, "utf8");
  try {
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(publicKey, address));
    const ciphertext = Buffer.concat([cipher.update(privateKeyBytes), cipher.final()]);
    return {
      version: 1,
      kdf: "scrypt",
      cipher: "aes-256-gcm",
      salt: salt.toString("hex"),
      iv: iv.toString("hex"),
      tag: cipher.getAuthTag().toString("hex"),
      ciphertext: ciphertext.toString("hex"),
      publicKey,
      address
    };
  } finally {
    zeroizeSecretBuffer(privateKeyBytes);
    zeroizeSecretBuffer(key);
  }
}

export function decryptPrivateKey(value: unknown, password: string): string {
  assertPassword(password);
  const keystore = parseEncryptedKeystore(value);
  const key = deriveKey(password, Buffer.from(keystore.salt, "hex"));
  try {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(keystore.iv, "hex"));
      decipher.setAAD(aad(keystore.publicKey, keystore.address));
      decipher.setAuthTag(Buffer.from(keystore.tag, "hex"));
      const privateKeyBytes = Buffer.concat([
        decipher.update(Buffer.from(keystore.ciphertext, "hex")),
        decipher.final()
      ]);
      try {
        const privateKey = privateKeyBytes.toString("utf8");
        assertPrivateKey(privateKey);
        const publicKey = publicKeyFromPrivate(privateKey);
        if (publicKey !== keystore.publicKey || addressFromPublicKey(publicKey) !== keystore.address) {
          throw new Error("Encrypted keystore identity mismatch");
        }
        return privateKey;
      } finally {
        zeroizeSecretBuffer(privateKeyBytes);
      }
    } catch {
      throw new Error("Encrypted keystore authentication failed");
    }
  } finally {
    zeroizeSecretBuffer(key);
  }
}

export function isEncryptedKeystore(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (value as Record<string, unknown>).version === 1 &&
    (value as Record<string, unknown>).kdf === "scrypt" &&
    (value as Record<string, unknown>).cipher === "aes-256-gcm";
}

export function normalizePasswordFile(contents: string): string {
  if (Buffer.byteLength(contents, "utf8") > 1_024) throw new Error("Keystore password file is too large");
  const password = contents.replace(/\r?\n$/, "");
  assertPassword(password);
  return password;
}

function parseEncryptedKeystore(value: unknown): EncryptedKeystoreV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Encrypted keystore is invalid");
  }
  const record = value as Record<string, unknown>;
  const expected = ["address", "cipher", "ciphertext", "iv", "kdf", "publicKey", "salt", "tag", "version"];
  const actual = Object.keys(record).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error("Encrypted keystore has unexpected fields");
  }
  if (record.version !== 1 || record.kdf !== "scrypt" || record.cipher !== "aes-256-gcm") {
    throw new Error("Encrypted keystore algorithm is unsupported");
  }
  assertHex(record.salt, 64, "salt");
  assertHex(record.iv, 24, "iv");
  assertHex(record.tag, 32, "tag");
  assertHex(record.ciphertext, 128, "ciphertext");
  if (typeof record.publicKey !== "string" || !/^[0-9a-f]{128}$/.test(record.publicKey)) {
    throw new Error("Encrypted keystore public key is invalid");
  }
  if (typeof record.address !== "string" || !/^ZYN[0-9a-f]{40}$/.test(record.address)) {
    throw new Error("Encrypted keystore address is invalid");
  }
  return record as unknown as EncryptedKeystoreV1;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  });
}

function aad(publicKey: string, address: string): Buffer {
  return Buffer.from(`${KEYSTORE_DOMAIN}\n${publicKey}\n${address}`, "utf8");
}

function assertPrivateKey(value: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Private key is invalid");
  publicKeyFromPrivate(value);
}

function assertPassword(value: string): void {
  if (value.length < 12) throw new Error("Keystore password must contain at least 12 characters");
  if (value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    throw new Error("Keystore password contains forbidden characters");
  }
}

function assertHex(value: unknown, length: number, name: string): asserts value is string {
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/.test(value)) {
    throw new Error(`Encrypted keystore ${name} is invalid`);
  }
}
