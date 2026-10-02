#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { buildPublicTestnetGenesis } from "../dist/src/public-testnet-governance.js";

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    console.error(`Missing ${name}`);
    process.exit(1);
  }
  return value;
}

if (!args.includes("--config") || !args.includes("--out")) {
  console.error("Usage: node scripts/build-public-testnet-genesis.mjs --config <governance-approved-testnet.json> --out <directory>");
  process.exit(1);
}

const configPath = resolve(option("--config"));
const outDir = resolve(option("--out"));
let built;
try {
  built = buildPublicTestnetGenesis(JSON.parse(await readFile(configPath, "utf8")));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(resolve(outDir, "genesis.json"), built.genesisBytes, { flag: "wx" });
await writeFile(resolve(outDir, "genesis-report.json"), built.reportBytes, { flag: "wx" });
process.stdout.write(built.reportBytes);
