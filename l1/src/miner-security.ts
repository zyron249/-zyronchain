import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { decryptPrivateKey, isEncryptedKeystore, normalizePasswordFile } from "./keystore.js";
import { assertPrivateRegularFile } from "./local-security.js";

/**
 * Load a miner key only from the encrypted local-keystore format.
 *
 * Mining is a public-facing operator workflow, so unlike legacy devnet key
 * readers it deliberately refuses plaintext private-key JSON. On POSIX systems
 * both the keystore and password file must also be owner-only before either is
 * read.
 */
export async function loadEncryptedMinerPrivateKey(keyPath: string, passwordPath: string): Promise<string> {
  const resolvedKeyPath = resolve(keyPath);
  const resolvedPasswordPath = resolve(passwordPath);

  await assertPrivateRegularFile(resolvedKeyPath, "Miner keystore");
  await assertPrivateRegularFile(resolvedPasswordPath, "Miner password file");

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolvedKeyPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Miner keystore is not valid JSON");
    throw error;
  }
  if (!isEncryptedKeystore(parsed)) {
    throw new Error("Miner requires an encrypted ZyronChain keystore; plaintext private-key files are not accepted");
  }

  const password = normalizePasswordFile(await readFile(resolvedPasswordPath, "utf8"));
  return decryptPrivateKey(parsed, password);
}
