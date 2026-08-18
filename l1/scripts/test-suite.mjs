#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const legacyFlakyName = "signing journal releases its writer lease after hard crash without losing the reserved choice";
const escaped = legacyFlakyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Node may match test-name patterns against a hierarchical/full name rather than
// only the displayed leaf title. Reject the legacy title wherever it appears in
// that full name; the deterministic IPC regression remains mandatory below.
const pattern = `^(?!.*${escaped}).*$`;
const filter = new RegExp(pattern);
if (filter.test(legacyFlakyName) || filter.test(`l1.test.js > ${legacyFlakyName}`) || !filter.test("signing journal prevents validator double-sign across restart")) {
  throw new Error("Legacy signing-lease exclusion filter is not fail-closed");
}

const directory = join(process.cwd(), "dist", "test");
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(directory, name));

if (files.length === 0) throw new Error("No compiled L1 tests found");
if (!files.some((path) => path.endsWith("signing-lease-crash.test.js"))) {
  throw new Error("Deterministic signing-lease crash regression is missing");
}
const legacySuite = await readFile(join(directory, "l1.test.js"), "utf8");
if (!legacySuite.includes(legacyFlakyName)) {
  throw new Error("Legacy signing-lease regression name changed; review the deterministic replacement filter");
}

const child = spawn(process.execPath, ["--test", `--test-name-pattern=${pattern}`, ...files], {
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
