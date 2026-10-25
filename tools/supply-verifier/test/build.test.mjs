import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

test("artifact build is byte-identical across runs and lists its files", () => {
  const build = () => { execFileSync(process.execPath, [join(root, "build.mjs")]); return execFileSync(process.execPath, [join(root, "hash.mjs")], { encoding: "utf8" }); };
  const first = build();
  const second = build();
  assert.match(first, /^[0-9a-f]{64} {2}zyron-supply-verifier\.tar\n$/);
  assert.equal(first, second);
  const manifest = readFileSync(join(root, "dist", "MANIFEST.sha256"), "utf8");
  for (const name of ["tools/supply-verifier/cli.mjs", "tools/supply-verifier/src/verify.mjs", "l1/package-lock.json", "l1/dist/src/chain.js"]) {
    assert.match(manifest, new RegExp(`^[0-9a-f]{64}  ${name.replace(/\./g, "\\.")}$`, "m"));
  }
});
