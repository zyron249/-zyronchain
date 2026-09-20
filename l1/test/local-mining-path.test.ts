import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const l1Root = process.cwd();

test("local-devnet refuses to combine --check with --local-v5", () => {
  const result = spawnSync(process.execPath, ["scripts/local-devnet.mjs", "--check", "--local-v5"], {
    cwd: l1Root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be combined/);
  assert.match(result.stderr, /does not activate public mining/);
});

test("local-devnet help describes the loopback-only v5 rehearsal", () => {
  const result = spawnSync(process.execPath, ["scripts/local-devnet.mjs", "--help"], {
    cwd: l1Root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--local-v5/);
  assert.match(result.stdout, /does not activate public mining/);
  assert.doesNotMatch(result.stdout, /rpc\.zyronchain\.com|publicTestnetActivationAllowed=true/);
});

test("packaged miner fail-closes non-loopback plaintext HTTP before reading secrets", () => {
  const result = spawnSync(process.execPath, [
    "scripts/mine.mjs",
    "--genesis", join(l1Root, "package.json"),
    "--key", join(l1Root, "package.json"),
    "--password-file", join(l1Root, "package.json"),
    "--rpc", "http://203.0.113.10:9137"
  ], {
    cwd: l1Root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.notEqual(result.status, 0);
  const output = `${result.stderr}\n${result.stdout}`;
  assert.match(output, /Remote mining RPC must use HTTPS|HTTP is allowed only for loopback/);
});

test("package scripts keep mine:local as a local-devnet --local-v5 wrapper", async () => {
  const pkg = JSON.parse(await readFile(join(l1Root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts.mine, "node scripts/mine.mjs");
  assert.match(pkg.scripts["mine:local"] ?? "", /local-devnet\.mjs --local-v5/);
  assert.equal(pkg.scripts["devnet:check"], "npm run build && node scripts/local-devnet.mjs --check");
  assert.doesNotMatch(pkg.scripts["devnet:check"], /local-v5/);
});
