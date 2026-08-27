import { resolve } from "node:path";

import { publicKeyFromPrivate } from "./crypto.js";
import { decryptPrivateKey, isEncryptedKeystore, normalizePasswordFile } from "./keystore.js";
import { readPrivateRegularFile } from "./local-security.js";

const MAX_VALIDATOR_KEY_JSON_NESTING_DEPTH = 32;
const MAX_VALIDATOR_KEY_JSON_STRUCTURAL_TOKENS = 4_096;

export async function readOperatorPrivateKey(
  path: string,
  passwordPath?: string
): Promise<string> {
  let parsed: Record<string, unknown>;
  try {
    const contents = await readPrivateRegularFile(resolve(path), "Validator key file");
    assertValidatorKeyJsonComplexity(contents);
    parsed = JSON.parse(contents) as Record<string, unknown>;
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

  const fields = Object.keys(parsed);
  if (fields.length !== 1 || fields[0] !== "privateKey") {
    throw new Error("Plaintext validator key file must contain exactly privateKey");
  }
  if (typeof parsed.privateKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.privateKey)) {
    throw new Error("Validator key file is invalid");
  }
  publicKeyFromPrivate(parsed.privateKey);
  return parsed.privateKey;
}

export async function readOperatorAuthToken(path: string, label: string): Promise<string> {
  const contents = await readPrivateRegularFile(resolve(path), `${label} token file`);
  const token = contents.endsWith("\r\n")
    ? contents.slice(0, -2)
    : contents.endsWith("\n")
      ? contents.slice(0, -1)
      : contents;
  if (!/^[\x21-\x7e]{32,512}$/.test(token)) {
    throw new Error(`${label} token file must contain a single canonical 32-512 character token`);
  }
  return token;
}

function assertValidatorKeyJsonComplexity(contents: string): void {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let tokens = 0;

  for (let index = 0; index < contents.length; index += 1) {
    const code = contents.charCodeAt(index);
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (code === 0x5c) {
        escaped = true;
        continue;
      }
      if (code === 0x22) inString = false;
      continue;
    }

    if (code === 0x22) {
      inString = true;
      continue;
    }
    if (code === 0x7b || code === 0x5b) {
      depth += 1;
      tokens += 1;
      if (depth > MAX_VALIDATOR_KEY_JSON_NESTING_DEPTH) {
        throw new Error("Validator key file JSON complexity exceeded");
      }
    } else if (code === 0x7d || code === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (code === 0x2c || code === 0x3a) {
      tokens += 1;
    }
    if (tokens > MAX_VALIDATOR_KEY_JSON_STRUCTURAL_TOKENS) {
      throw new Error("Validator key file JSON complexity exceeded");
    }
  }
}
