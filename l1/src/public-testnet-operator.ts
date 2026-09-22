import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "./crypto.js";
import { encryptPrivateKey, type EncryptedKeystoreV1 } from "./keystore.js";
import { nodeIdFromPublicKey } from "./peer-identity.js";

export const VALIDATOR_LABELS = ["validator-a", "validator-b", "validator-c"] as const;
export const BOOTSTRAP_LABELS = ["bootstrap-a", "bootstrap-b", "bootstrap-c"] as const;

export interface PublicOperatorRecord {
  label: string;
  role: "validator" | "bootstrap";
  publicKey: string;
  address: string;
  nodeIdentity: string;
  weight: 1;
}

export function assertOperatorLabel(role: "validator" | "bootstrap", label: string): void {
  const allowed: readonly string[] = role === "validator" ? VALIDATOR_LABELS : BOOTSTRAP_LABELS;
  if (!allowed.includes(label)) {
    throw new Error(`Operator label must be one of ${allowed.join(", ")}`);
  }
}

export async function createOperatorKeystore(options: {
  role: "validator" | "bootstrap";
  label: string;
  directory: string;
  password: string;
}): Promise<PublicOperatorRecord> {
  assertOperatorLabel(options.role, options.label);
  if (options.password.length < 8) throw new Error("Operator password is too short");
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const keystorePath = join(options.directory, `${options.label}.keystore.json`);
  const publicPath = join(options.directory, `${options.label}.public.json`);
  await assertCreatable(keystorePath);
  await assertCreatable(publicPath);
  const privateKey = generatePrivateKey();
  const publicKey = publicKeyFromPrivate(privateKey);
  const address = addressFromPublicKey(publicKey);
  const nodeIdentity = nodeIdFromPublicKey(publicKey);
  const stored = encryptPrivateKey(privateKey, options.password);
  if (JSON.stringify(stored).includes(privateKey)) {
    throw new Error("Operator keystore would expose the private key");
  }
  const record: PublicOperatorRecord = {
    label: options.label,
    role: options.role,
    publicKey,
    address,
    nodeIdentity,
    weight: 1
  };
  if ("privateKey" in record || JSON.stringify(record).includes(privateKey)) {
    throw new Error("Operator public record would expose the private key");
  }
  await writeExclusive(keystorePath, `${JSON.stringify(stored, null, 2)}\n`);
  try {
    await writeExclusive(publicPath, `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    await rm(keystorePath, { force: true });
    throw error;
  }
  return record;
}

export async function readOperatorPublicRecord(directory: string, label: string): Promise<PublicOperatorRecord> {
  if (label.endsWith(".keystore") || label.includes("keystore")) {
    throw new Error("Public export refuses keystore material");
  }
  const publicPath = join(directory, `${label}.public.json`);
  await assertRegularFile(publicPath);
  const parsed = JSON.parse(await readFile(publicPath, "utf8")) as PublicOperatorRecord;
  if (!parsed || typeof parsed !== "object" || !("publicKey" in parsed) || "ciphertext" in parsed || "privateKey" in parsed) {
    throw new Error("Operator public record is not a public identity");
  }
  if (parsed.weight !== 1) throw new Error("Operator weight must stay 1");
  if ("multiaddr" in parsed) throw new Error("Operator public export must not invent a multiaddr");
  return {
    label: parsed.label,
    role: parsed.role,
    publicKey: parsed.publicKey,
    address: parsed.address,
    nodeIdentity: parsed.nodeIdentity,
    weight: 1
  };
}

export function publicExportText(record: PublicOperatorRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

async function assertCreatable(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error("Refusing to write through a symlink or junction");
    throw new Error("Refusing to overwrite an existing operator file");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return;
    throw error;
  }
}

async function assertRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error("Refusing to read through a symlink or junction");
  if (!stat.isFile()) throw new Error("Operator public record is not a regular file");
}

async function writeExclusive(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
}

export function assertKeystoreHasNoPrivateKey(keystore: EncryptedKeystoreV1, privateKey: string): void {
  const encoded = JSON.stringify(keystore);
  if (encoded.includes(privateKey)) throw new Error("Keystore contains the private key");
}
