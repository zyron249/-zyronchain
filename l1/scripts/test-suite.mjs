#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const legacyFlakyName = "signing journal releases its writer lease after hard crash without losing the reserved choice";
const deterministicName = "signing journal hard-crash lease uses deterministic holder liveness";
export const L1_TEST_TIMEOUT_MS = 10 * 60 * 1000;
const directory = join(process.cwd(), "dist", "test");
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(directory, name));

if (files.length === 0) throw new Error("No compiled L1 tests found");
const deterministicPath = files.find((path) => path.endsWith("signing-lease-crash.test.js"));
if (!deterministicPath) {
  throw new Error("Deterministic signing-lease crash regression is missing");
}

const legacySuite = await readFile(join(directory, "l1.test.js"), "utf8");
if (legacySuite.includes(legacyFlakyName)) {
  throw new Error("Legacy process-racy signing-lease crash regression was reintroduced");
}
const deterministicSuite = await readFile(deterministicPath, "utf8");
if (!deterministicSuite.includes(deterministicName)) {
  throw new Error("Deterministic signing-lease crash regression title changed or disappeared");
}

const child = spawn(process.execPath, [
  "--test",
  `--test-timeout=${L1_TEST_TIMEOUT_MS}`,
  ...files
], {
  stdio: "inherit"
});
child.once("error", (error) => {
  console.error(error);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`L1 test runner terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
