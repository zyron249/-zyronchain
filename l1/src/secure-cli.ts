#!/usr/bin/env node
import { rmSync } from "node:fs";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { enforceCanonicalCliSecurityPolicy } from "./cli-policy.js";
import { readCliGovernanceArtifactUtf8 } from "./cli-governance-file.js";
import {
  readCliCheckpointSnapshotAnchoredUtf8,
  readCliGenesisUtf8
} from "./cli-recovery-file.js";

const hardenedCommands = new Set([
  "snapshot", "checkpoint-install", "checkpoint-fetch-install", "state-fetch-install", "prune-finalized", "node",
  "validator-approve", "validator-submit", "protocol-approve", "protocol-submit"
]);

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

function optionValueIndexes(args: string[], name: string): number[] {
  const found: number[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    found.push(index + 1);
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

async function stageRepeated(
  args: string[],
  name: string,
  destinationPrefix: string,
  reader: (path: string) => Promise<string>
): Promise<void> {
  const indexes = optionValueIndexes(args, name);
  for (let position = 0; position < indexes.length; position += 1) {
    const index = indexes[position]!;
    const destination = `${destinationPrefix}-${position}.json`;
    const text = await reader(resolve(args[index]!));
    await writeFile(destination, text, { flag: "wx", mode: 0o600 });
    await chmod(destination, 0o600);
    args[index] = destination;
  }
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  // Enforce the public CLI's canonical custody/network policy at the actual
  // published entrypoint before staging or delegating any command. cli.ts also
  // reaches the same policy through rpc-client.ts; retaining that second check
  // is deliberate defense in depth rather than an implicit dependency.
  enforceCanonicalCliSecurityPolicy(args);

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
    const shaIndex = optionValueIndex(args, "--sha256");
    if (shaIndex === -1) throw new Error("checkpoint-install requires --sha256 <lowercase-hex>");
    const expectedSha256 = args[shaIndex]!;
    await stage(
      args,
      "--snapshot",
      join(dir, "checkpoint.json"),
      (path) => readCliCheckpointSnapshotAnchoredUtf8(path, expectedSha256)
    );
  }
  if (["validator-approve", "validator-submit", "protocol-approve", "protocol-submit"].includes(command)) {
    await stage(args, "--proposal", join(dir, "governance-proposal.json"), readCliGovernanceArtifactUtf8);
  }
  if (command === "validator-submit" || command === "protocol-submit") {
    await stageRepeated(args, "--approval", join(dir, "governance-approval"), readCliGovernanceArtifactUtf8);
  }

  process.argv = [process.argv[0]!, process.argv[1]!, ...args];
  await import("./cli.js");
}

run().catch((error: unknown) => {
  console.error(`Fatal: ${error instanceof Error ? error.message : "operation failed"}`);
  process.exitCode = 1;
});
