import { resolve } from "node:path";

import { publicKeyFromPrivate } from "./crypto.js";
import { decryptPrivateKey, isEncryptedKeystore, normalizePasswordFile } from "./keystore.js";
import { readPrivateRegularFile } from "./local-security.js";

export async function readOperatorPrivateKey(
  path: string,
  passwordPath?: string
): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await readPrivateRegularFile(resolve(path), "Validator key file")) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Validator key file is invalid JSON");
    throw error;
  }

  if (isEncryptedKeystore(parsed)) {
    if (!passwordPath) throw new Error("Encrypted keystore requires ZYRON_KEYSTORE_PASSWORD_FILE");
    const password = normalizePasswordFile(
      await readPrivateRegularFile(resolve(passwordPath), "Keystore password file")
    );
    return decryptPrivateKey(parsed, password);
  }

  if (typeof parsed.privateKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.privateKey)) {
    throw new Error("Validator key file is invalid");
  }
  publicKeyFromPrivate(parsed.privateKey);
  return parsed.privateKey;
}

export async function readOperatorAuthToken(path: string, label: string): Promise<string> {
  const token = (await readPrivateRegularFile(resolve(path), `${label} token file`)).trim();
  if (token.length < 32 || token.length > 512 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error(`${label} token file must contain a single 32-512 character token`);
  }
  return token;
}
