import { resolve } from "node:path";

import { decryptPrivateKey, isEncryptedKeystore, normalizePasswordFile } from "./keystore.js";
import { readPrivateRegularFile } from "./local-security.js";

const MAX_MINER_KEYSTORE_JSON_NESTING_DEPTH = 32;
const MAX_MINER_KEYSTORE_JSON_STRUCTURAL_TOKENS = 4_096;

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
    const contents = await readPrivateRegularFile(resolvedKeyPath, "Miner keystore");
    assertMinerKeystoreJsonComplexity(contents);
    parsed = JSON.parse(contents);
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

function assertMinerKeystoreJsonComplexity(contents: string): void {
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
      if (depth > MAX_MINER_KEYSTORE_JSON_NESTING_DEPTH) {
        throw new Error("Miner keystore JSON complexity exceeded");
      }
    } else if (code === 0x7d || code === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (code === 0x2c || code === 0x3a) {
      tokens += 1;
    }
    if (tokens > MAX_MINER_KEYSTORE_JSON_STRUCTURAL_TOKENS) {
      throw new Error("Miner keystore JSON complexity exceeded");
    }
  }
}
