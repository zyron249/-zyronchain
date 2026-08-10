#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || process.argv[index + 1] === undefined) throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function requiredEnv(name, pattern) {
  const value = process.env[name];
  if (!value || (pattern && !pattern.test(value))) throw new Error(`Invalid or missing ${name}`);
  return value;
}

const scenario = option("--scenario");
const resultPath = option("--result");
const outputPath = option("--out");
if (!/^[a-z0-9][a-z0-9-]{2,80}$/.test(scenario)) throw new Error("Invalid evidence scenario name");

const raw = await readFile(resultPath);
const result = JSON.parse(raw.toString("utf8"));
assert.ok(result && typeof result === "object" && !Array.isArray(result), "Evidence result must be a JSON object");
assert.equal(result.status, "ok", "Only successful rehearsal evidence may be archived");

const runId = Number(requiredEnv("GITHUB_RUN_ID", /^\d+$/));
const runAttempt = Number(requiredEnv("GITHUB_RUN_ATTEMPT", /^\d+$/));
assert.ok(Number.isSafeInteger(runId) && runId > 0, "Invalid GITHUB_RUN_ID");
assert.ok(Number.isSafeInteger(runAttempt) && runAttempt > 0, "Invalid GITHUB_RUN_ATTEMPT");

const envelope = {
  evidenceVersion: 1,
  scenario,
  repository: requiredEnv("GITHUB_REPOSITORY", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  commitSha: requiredEnv("GITHUB_SHA", /^[0-9a-f]{40}$/),
  workflow: requiredEnv("GITHUB_WORKFLOW"),
  job: requiredEnv("GITHUB_JOB", /^[A-Za-z0-9_.-]+$/),
  runId,
  runAttempt,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch
  },
  resultSha256: createHash("sha256").update(raw).digest("hex"),
  result
};

await writeFile(outputPath, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx", mode: 0o644 });
