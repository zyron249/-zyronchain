#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const legacyFlakyName = "signing journal releases its writer lease after hard crash without losing the reserved choice";
const escaped = legacyFlakyName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = `^(?!${escaped}$).*`;
const directory = join(process.cwd(), "dist", "test");
const files = (await readdir(directory))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join(directory, name));

if (files.length === 0) throw new Error("No compiled L1 tests found");

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
