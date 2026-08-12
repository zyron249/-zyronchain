import { resolve } from "node:path";

import { decryptPrivateKey, isEncryptedKeystore, normalizePasswordFile } from "./keystore.js";
import { readPrivateRegularFile } from "./local-security.js";

/**
 * Load a miner key only from the encrypted local-keystore format.
 *
 * Mining is a public-facing operator workflow, so unlike legacy devnet key
 * readers it deliberately refuses plaintext private-key JSON. On POSIX systems
 * both the keystore and password file must also be owner-only before either is
 * read. Secret paths must not be symlinks and the validated descriptor is the
 * descriptor that is actually read, preventing path-swap races.
 */
export async function loadEncryptedMinerPrivateKey(keyPath: string, passwordPath: string): Promise<string> {
  const resolvedKeyPath = resolve(keyPath);
  const resolvedPasswordPath = resolve(passwordPath);

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readPrivateRegularFile(resolvedKeyPath, "Miner keystore"));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Miner keystore is not valid JSON");
    throw error;
  }
  if (!isEncryptedKeystore(parsed)) {
    throw new Error("Miner requires an encrypted ZyronChain keystore; plaintext private-key files are not accepted");
  }

  const password = normalizePasswordFile(await readPrivateRegularFile(resolvedPasswordPath, "Miner password file"));
  return decryptPrivateKey(parsed, password);
}
