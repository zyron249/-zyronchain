import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

// 6A / #1146: the CLI never signs transaction version 1, so a protocol-1 local
// devnet cannot complete its transfer step. Plain `npm run devnet` therefore
// starts a protocol-v6 chain by default, and the protocol-1 path is an explicit
// opt-in (`--v1-legacy`, `npm run devnet:v1-legacy`, `npm run devnet:check:v1-legacy`).

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const launcher = join(l1Root, "scripts/local-devnet.mjs");
const optionsModule = join(l1Root, "scripts/local-devnet-options.mjs");

type DevnetOptions = { check: boolean; help: boolean; protocol: 1 | 6; error?: string; retiredLocalV5?: boolean };
async function loadParser(): Promise<(args: string[]) => DevnetOptions> {
  const mod = (await import(pathToFileURL(optionsModule).href)) as { parseDevnetArgs: (args: string[]) => DevnetOptions };
  assert.equal(typeof mod.parseDevnetArgs, "function");
  return mod.parseDevnetArgs;
}

test("local-devnet defaults to protocol v6 with no flags (plain npm run devnet)", async () => {
  const parse = await loadParser();
  const plain = parse([]);
  assert.equal(plain.error, undefined);
  assert.equal(plain.protocol, 6);
  assert.equal(plain.check, false);
  const check = parse(["--check"]);
  assert.equal(check.protocol, 6);
  assert.equal(check.check, true);
  // --v6 stays accepted as an explicit spelling of the default.
  assert.equal(parse(["--v6"]).protocol, 6);
  assert.equal(parse(["--check", "--v6"]).protocol, 6);
});

test("local-devnet protocol 1 is only reachable through the explicit --v1-legacy opt-in", async () => {
  const parse = await loadParser();
  assert.equal(parse(["--v1-legacy"]).protocol, 1);
  const legacyCheck = parse(["--check", "--v1-legacy"]);
  assert.equal(legacyCheck.protocol, 1);
  assert.equal(legacyCheck.check, true);
  assert.match(parse(["--v6", "--v1-legacy"]).error ?? "", /cannot be combined/);
  assert.match(parse(["--v1"]).error ?? "", /Usage/);
  assert.match(parse(["--legacy"]).error ?? "", /Usage/);
  assert.equal(parse(["--local-v5"]).retiredLocalV5, true);
});

test("local-devnet launcher uses the shared option parser and refuses conflicting protocol flags", async () => {
  const source = await readFile(launcher, "utf8");
  assert.match(source, /from '\.\/local-devnet-options\.mjs'/);
  assert.match(source, /parseDevnetArgs\(process\.argv\.slice\(2\)\)/);
  const conflict = spawnSync(process.execPath, [launcher, "--v6", "--v1-legacy"], { cwd: l1Root, encoding: "utf8", windowsHide: true });
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /cannot be combined/);
  assert.equal(conflict.stdout, "");
  const help = spawnSync(process.execPath, [launcher, "--help"], { cwd: l1Root, encoding: "utf8", windowsHide: true });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /protocol v6 by default/);
  assert.match(help.stdout, /--v1-legacy/);
});

test("package scripts: devnet runs the v6 default, protocol-1 scripts pass --v1-legacy explicitly", async () => {
  const pkg = JSON.parse(await readFile(join(l1Root, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.devnet, "npm run build && node scripts/local-devnet.mjs");
  assert.equal(pkg.scripts["devnet:v1-legacy"], "npm run build && node scripts/local-devnet.mjs --v1-legacy");
  assert.equal(pkg.scripts["devnet:check:v1-legacy"], "npm run build && node scripts/local-devnet.mjs --check --v1-legacy");
  for (const [name, script] of Object.entries(pkg.scripts)) {
    if (!script.includes("local-devnet.mjs") || name.includes("v1-legacy") || name === "mine:local") continue;
    assert.doesNotMatch(script, /--v1-legacy/, `${name} must not opt into protocol 1`);
  }
});
