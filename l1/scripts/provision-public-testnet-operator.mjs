#!/usr/bin/env node
import { resolve } from "node:path";

import { readPrivateRegularFile } from "../dist/src/local-security.js";
import {
  createOperatorKeystore,
  publicExportText,
  readOperatorPublicRecord
} from "../dist/src/public-testnet-operator.js";

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return undefined;
  return args[index + 1];
}

const role = option("--role");
const label = option("--label");
const directory = option("--dir");
const passwordFile = option("--password-file");
const exportPublic = args.includes("--export-public");

if (role !== "validator" && role !== "bootstrap") throw new Error("--role must be validator or bootstrap");
if (!label || !directory) throw new Error("--label and --dir are required");

if (exportPublic) {
  const record = await readOperatorPublicRecord(resolve(directory), label);
  process.stdout.write(publicExportText(record));
} else {
  if (!passwordFile) throw new Error("--password-file is required");
  const password = String(await readPrivateRegularFile(resolve(passwordFile), "Operator password file")).trim();
  const record = await createOperatorKeystore({ role, label, directory: resolve(directory), password });
  process.stdout.write(publicExportText(record));
}
