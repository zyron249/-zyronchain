import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const l1Root = process.cwd();

// RETIRED (owner decision 2026-09-30): mining is shut down for every genesis.
// These tests previously pinned the local mining rehearsal path; they now pin
// that every mining entry point fails closed.
test("local-devnet refuses --local-v5 (alone or with --check) because mining is retired", () => {
  for (const args of [["--local-v5"], ["--check", "--local-v5"]]) {
    const result = spawnSync(process.execPath, ["scripts/local-devnet.mjs", ...args], {
      cwd: l1Root,
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /retired/);
    assert.match(result.stderr, /rejects every mining_claim/);
  }
});

test("local-devnet help marks --local-v5 as retired", () => {
  const result = spawnSync(process.execPath, ["scripts/local-devnet.mjs", "--help"], {
    cwd: l1Root,
    encoding: "utf8",
    windowsHide: true
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--local-v5 is retired/);
  assert.doesNotMatch(result.stdout, /rpc\.zyronchain\.com|publicTestnetActivationAllowed=true/);
});

test("packaged miner is disabled: exits non-zero as retired before validating RPC or reading secrets", () => {
  for (const rpc of ["http://203.0.113.10:9137", "http://127.0.0.1:9137"]) {
    const result = spawnSync(process.execPath, [
      "scripts/mine.mjs",
      "--genesis", join(l1Root, "package.json"),
      "--key", join(l1Root, "package.json"),
      "--password-file", join(l1Root, "package.json"),
      "--rpc", rpc
    ], {
      cwd: l1Root,
      encoding: "utf8",
      windowsHide: true
    });
    assert.notEqual(result.status, 0);
    const output = `${result.stderr}\n${result.stdout}`;
    assert.match(output, /mining is retired/);
    assert.doesNotMatch(output, /password|keystore|Remote mining RPC/i);
  }
  const help = spawnSync(process.execPath, ["scripts/mine.mjs", "--help"], { cwd: l1Root, encoding: "utf8", windowsHide: true });
  assert.notEqual(help.status, 0);
  assert.match(`${help.stderr}`, /mining is retired/);
});

test("package mine scripts now route only to retired, fail-closed entry points", async () => {
  const pkg = JSON.parse(await readFile(join(l1Root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.equal(pkg.scripts.mine, "node scripts/mine.mjs");
  assert.match(pkg.scripts["mine:local"] ?? "", /local-devnet\.mjs --local-v5/);
  assert.equal(pkg.scripts["devnet:check"], "npm run build && node scripts/local-devnet.mjs --check");
  assert.doesNotMatch(pkg.scripts["devnet:check"], /local-v5/);
});
