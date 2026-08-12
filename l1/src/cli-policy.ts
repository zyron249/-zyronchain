import { existsSync, lstatSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeSecureRpcUrl } from "./local-security.js";

const PRIVATE_FILE_OPTIONS = [
  "--key",
  "--validator-key",
  "--password-file",
  "--peer-token-file",
  "--validator-signer-token-file"
] as const;

export function enforceCanonicalCliSecurityPolicy(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
  const [command] = argv;
  if (!command) return;

  for (const rpc of optionValues(argv, "--rpc")) normalizeSecureRpcUrl(rpc);

  if (command === "keygen" && optionValues(argv, "--password-file").length !== 1) {
    throw new Error("keygen requires --password-file; new plaintext private-key files are disabled");
  }

  for (const name of PRIVATE_FILE_OPTIONS) {
    for (const value of optionValues(argv, name)) assertPrivateRegularFileSync(value, name);
  }

  const passwordFile = env.ZYRON_KEYSTORE_PASSWORD_FILE;
  if (passwordFile) assertPrivateRegularFileSync(passwordFile, "ZYRON_KEYSTORE_PASSWORD_FILE");

  if (command === "node") {
    const dataValues = optionValues(argv, "--data");
    if (dataValues.length === 1) {
      const identityPath = resolve(dataValues[0]!, "node-identity.json");
      if (existsSync(identityPath)) assertPrivateRegularFileSync(identityPath, "node identity");
    }
  }
}

function optionValues(argv: readonly string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] !== name) continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) continue;
    values.push(value);
    index += 1;
  }
  return values;
}

function assertPrivateRegularFileSync(path: string, label: string): void {
  const metadata = lstatSync(resolve(path));
  if (metadata.isSymbolicLink()) throw new Error(`${label} must not reference a symbolic link`);
  if (!metadata.isFile()) throw new Error(`${label} must reference a regular file`);
  if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group/other users (0600 recommended)`);
  }
}
