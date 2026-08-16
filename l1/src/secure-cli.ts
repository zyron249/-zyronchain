#!/usr/bin/env node
import { rmSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { readCliCheckpointSnapshotUtf8, readCliGenesisUtf8 } from "./cli-recovery-file.js";

const hardenedCommands = new Set(["snapshot", "checkpoint-install", "checkpoint-fetch-install", "state-fetch-install", "prune-finalized", "node"]);

function optionValueIndex(args: string[], name: string): number {
  let found = -1;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    if (found !== -1) throw new Error(`${name} may only be supplied once`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    found = index + 1;
    index += 1;
  }
  return found;
}

async function stage(args: string[], name: string, destination: string, reader: (path: string) => Promise<string>): Promise<void> {
  const index = optionValueIndex(args, name);
  if (index === -1) return;
  const text = await reader(resolve(args[index]!));
  await writeFile(destination, text, { flag: "wx", mode: 0o600 });
  await chmod(destination, 0o600);
  args[index] = destination;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || !hardenedCommands.has(command)) {
    await import("./cli.js");
    return;
  }

  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-input-"));
  await chmod(dir, 0o700);
  process.once("exit", () => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { }
  });

  await stage(args, "--genesis", join(dir, "genesis.json"), readCliGenesisUtf8);
  if (command === "checkpoint-install") {
    await stage(args, "--snapshot", join(dir, "checkpoint.json"), readCliCheckpointSnapshotUtf8);
  }

  process.argv = [process.argv[0]!, process.argv[1]!, ...args];
  await import("./cli.js");
}

run().catch((error: unknown) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : "operation failed"}`);
  process.exitCode = 1;
});
