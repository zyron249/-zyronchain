#!/usr/bin/env node
// Rebuilds the reproducible supply-verifier tar and records its sha256.
// Shared by `npm run pin-hash` (repo root) and the reproducible-build CI workflow,
// so local pin updates and CI use the same build steps.
//
//   node tools/supply-verifier/pin-hash.mjs           build, write EXPECTED_SHA256
//   node tools/supply-verifier/pin-hash.mjs --print   build, print hash only (CI)
//   node tools/supply-verifier/pin-hash.mjs --validate check EXPECTED_SHA256 format
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const printOnly = process.argv.includes("--print");
const expectedPath = join(here, "EXPECTED_SHA256");
// Exactly 64 lowercase hex chars, optionally followed by whitespace and a filename.
const PIN_RE = /^[0-9a-f]{64}(?:[ \t]+\S.*)?[ \t]*\r?\n?$/;

if (process.argv.includes("--validate")) {
  let text = "";
  try { text = readFileSync(expectedPath, "utf8"); } catch {}
  if (!PIN_RE.test(text)) {
    console.error("tools/supply-verifier/EXPECTED_SHA256 is malformed: expected 64 lowercase hex characters, optionally followed by whitespace and a filename.");
    process.exit(1);
  }
  process.exit(0);
}

const wantNode = readFileSync(join(here, ".nvmrc"), "utf8").trim().replace(/^v/, "");
const haveNode = process.versions.node;
if (haveNode !== wantNode) {
  console.error(
    `warning: Node ${haveNode} differs from tools/supply-verifier/.nvmrc (${wantNode}); ` +
      "the hash may not match CI. Switch Node versions before committing the pin.",
  );
}

execFileSync(process.execPath, [join(here, "build.mjs"), "--clean-l1"], {
  cwd: root,
  stdio: ["ignore", "ignore", "inherit"],
});
const line = execFileSync(process.execPath, [join(here, "hash.mjs")], { cwd: root, encoding: "utf8" });

if (printOnly) {
  process.stdout.write(line);
} else {
  const expected = expectedPath;
  if (!PIN_RE.test(line)) throw new Error(`unexpected hash output: ${line}`);
  writeFileSync(expected, line);
  console.log(`wrote ${relative(root, expected)}: ${line.trim()}`);
  console.log("Commit it in the same PR as the change that caused it, and explain why in the PR.");
}
