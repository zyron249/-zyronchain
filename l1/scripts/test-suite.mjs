#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const legacyFlakyName = "signing journal releases its writer lease after hard crash without losing the reserved choice";
const deterministicName = "signing journal hard-crash lease uses deterministic holder liveness";
const legacyUnauthenticatedRemoteSignerNames = [
  "remote validator signer keeps the secret out of the node and signs proposals plus attestations",
  "remote validator signer is fail-closed on wrong-key signatures and unsafe plaintext endpoints",
  "remote validator signer binds protocol v3 requests and responses to the exact signing domain"
];
const authenticatedRemoteSignerReplacementNames = [
  "authenticated remote validator signer keeps the secret out of the node and signs proposals plus attestations",
  "authenticated remote validator signer is fail-closed on wrong-key signatures and unsafe plaintext endpoints",
  "authenticated remote validator signer binds protocol v3 requests and responses to the exact signing domain"
];
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
const remoteSignerReplacementPath = files.find((path) => path.endsWith("validator-signer-integration-auth.test.js"));
if (!remoteSignerReplacementPath) {
  throw new Error("Authenticated remote-signer integration regression is missing");
}

const legacySuite = await readFile(join(directory, "l1.test.js"), "utf8");
if (legacySuite.includes(legacyFlakyName)) {
  throw new Error("Legacy process-racy signing-lease crash regression was reintroduced");
}
for (const name of legacyUnauthenticatedRemoteSignerNames) {
  if (!legacySuite.includes(name)) {
    throw new Error(`Expected legacy unauthenticated remote-signer fixture disappeared without runner migration: ${name}`);
  }
}
const deterministicSuite = await readFile(deterministicPath, "utf8");
if (!deterministicSuite.includes(deterministicName)) {
  throw new Error("Deterministic signing-lease crash regression title changed or disappeared");
}
const remoteSignerReplacementSuite = await readFile(remoteSignerReplacementPath, "utf8");
for (const name of authenticatedRemoteSignerReplacementNames) {
  if (!remoteSignerReplacementSuite.includes(name)) {
    throw new Error(`Authenticated remote-signer replacement regression changed or disappeared: ${name}`);
  }
}

// The monolithic legacy suite predates mandatory library-boundary signer
// authentication. Skip only those three obsolete unauthenticated fixtures;
// their authenticated equivalents above remain in the same full test run.
const escapedLegacyRemoteSignerNames = legacyUnauthenticatedRemoteSignerNames
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
const testNamePattern = `^(?!(?:${escapedLegacyRemoteSignerNames.join("|")})$).*`;
const child = spawn(process.execPath, [
  "--test",
  `--test-timeout=${L1_TEST_TIMEOUT_MS}`,
  `--test-name-pattern=${testNamePattern}`,
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
