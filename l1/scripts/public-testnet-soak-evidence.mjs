#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assessSoakEvidence, parseSoakEvidenceCsv, parseSoakEvidenceJson } from "../dist/src/public-testnet-governance.js";

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

if (!args.includes("--duration") || !args.includes("--evidence")) {
  console.error("Usage: node scripts/public-testnet-soak-evidence.mjs --duration 24h|72h|7d --evidence <file.json|file.csv>");
  process.exit(1);
}

const duration = option("--duration");
if (duration !== "24h" && duration !== "72h" && duration !== "7d") {
  console.error("Soak duration must be 24h, 72h, or 7d");
  process.exit(1);
}

const path = resolve(option("--evidence"));
let samples;
try {
  const text = await readFile(path, "utf8");
  samples = path.endsWith(".csv") ? parseSoakEvidenceCsv(text) : parseSoakEvidenceJson(JSON.parse(text));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const result = assessSoakEvidence(samples, duration);
process.stdout.write(`${JSON.stringify({ duration, ...result }, null, 2)}\n`);
if (!result.progress) process.exitCode = 1;
