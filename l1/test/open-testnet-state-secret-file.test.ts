// The seal secret can come from ZYRON_TESTNET_STATE_SECRET_FILE, so a
// same-uid process (a compromised validator) cannot read it from
// /proc/<gateway pid>/environ. The env var stays as a fallback.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const secretModUrl = pathToFileURL(join(l1Root, "scripts", "open-testnet", "state-secret.mjs")).href;
const gatewayModUrl = pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mod: any = await import(secretModUrl);
const SECRET = "seal-secret-test-" + "q".repeat(40);
const linux = process.platform === "linux";

function tmp() { return mkdtempSync(join(tmpdir(), "zyron-seal-")); }
let fileSeq = 0;
function secretFile(dir: string, mode: number) { const p = join(dir, `state-secret-${fileSeq++}`); writeFileSync(p, SECRET + "\n"); chmodSync(p, mode); return p; }

// A stand-in gateway: loads the secret the way `run` does, then spawns a
// "validator" child with validatorChildEnv() that reads /proc/<ppid>/environ.
const gatewayScript = `
  const { loadStateSecret } = await import(${JSON.stringify(secretModUrl)});
  const { validatorChildEnv } = await import(${JSON.stringify(gatewayModUrl)});
  const { spawnSync } = await import("node:child_process");
  const loaded = loadStateSecret(process.env);
  const child = spawnSync(process.execPath, ["-e", \`
    const fs = require("node:fs");
    let environ = ""; try { environ = fs.readFileSync("/proc/" + process.ppid + "/environ", "latin1"); } catch (e) { environ = "ERR:" + e.code; }
    process.stdout.write(JSON.stringify({ environ, ownEnv: JSON.stringify(process.env) }));
  \`], { env: validatorChildEnv(), encoding: "utf8" });
  const out = JSON.parse(child.stdout);
  process.stdout.write(JSON.stringify({ source: loaded.source, ok: loaded.secret === process.argv[1],
    inProcessEnv: JSON.stringify(process.env).includes(process.argv[1]),
    inParentEnviron: out.environ.includes(process.argv[1]), environReadable: !out.environ.startsWith("ERR:"),
    inChildEnv: out.ownEnv.includes(process.argv[1]) }));
`;
function runGateway(env: Record<string, string>) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", gatewayScript, SECRET], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test("file mode: a same-uid child cannot find the secret in /proc/<gateway>/environ", { skip: !linux }, () => {
  const dir = tmp();
  try {
    const r = runGateway({ ZYRON_TESTNET_STATE_SECRET_FILE: secretFile(dir, 0o600) });
    assert.equal(r.source, "file"); assert.equal(r.ok, true);
    assert.equal(r.environReadable, true, "the child can read the gateway's environ (same uid), so the check is meaningful");
    assert.equal(r.inParentEnviron, false); assert.equal(r.inChildEnv, false); assert.equal(r.inProcessEnv, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("env fallback still works; it is removed from process.env and child env, but /proc environ keeps it (documented limit)", { skip: !linux }, () => {
  const r = runGateway({ ZYRON_TESTNET_STATE_SECRET: SECRET });
  assert.equal(r.source, "env"); assert.equal(r.ok, true);
  assert.equal(r.inProcessEnv, false); assert.equal(r.inChildEnv, false);
  assert.equal(r.inParentEnviron, true, "the kernel keeps the exec-time env block; only the file mode closes this");
});

test("a group- or world-readable secret file is refused", () => {
  const dir = tmp();
  try {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o666, 0o620, 0o602]) {
      const env: Record<string, string> = { ZYRON_TESTNET_STATE_SECRET_FILE: secretFile(dir, mode) };
      assert.throws(() => mod.loadStateSecret(env), mod.StateSecretFileError, mode.toString(8));
    }
    for (const mode of [0o600, 0o400]) assert.equal(mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: secretFile(dir, mode) }).secret, SECRET);
    // The group opt-in (platform-mounted secret files) never allows world access.
    assert.equal(mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: secretFile(dir, 0o640), ZYRON_TESTNET_STATE_SECRET_FILE_ALLOW_GROUP: "1" }).secret, SECRET);
    assert.throws(() => mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: secretFile(dir, 0o644), ZYRON_TESTNET_STATE_SECRET_FILE_ALLOW_GROUP: "1" }), mod.StateSecretFileError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a configured but unusable file never falls back to the env var, and errors never contain the secret", () => {
  const dir = tmp();
  try {
    const env: Record<string, string> = { ZYRON_TESTNET_STATE_SECRET_FILE: join(dir, "missing"), ZYRON_TESTNET_STATE_SECRET: SECRET };
    assert.throws(() => mod.loadStateSecret(env), (e: Error) => e instanceof mod.StateSecretFileError && !e.message.includes(SECRET));
    assert.equal(env.ZYRON_TESTNET_STATE_SECRET, undefined);
    const p = secretFile(dir, 0o644);
    assert.throws(() => mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: p }), (e: Error) => !e.message.includes(SECRET));
    writeFileSync(join(dir, "empty"), ""); chmodSync(join(dir, "empty"), 0o600);
    assert.throws(() => mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: join(dir, "empty") }), mod.StateSecretFileError);
    assert.throws(() => mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: dir }), mod.StateSecretFileError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no secret configured", () => {
  assert.deepEqual(mod.loadStateSecret({}), { secret: undefined, source: "none", envAlsoSet: false });
});

function rawFile(dir: string, name: string, data: string | Buffer) { const p = join(dir, name); writeFileSync(p, data); chmodSync(p, 0o600); return p; }

test("a FIFO at the configured path is refused without hanging start-up", { skip: !linux }, () => {
  const dir = tmp();
  try {
    const fifo = join(dir, "fifo");
    execFileSync("mkfifo", ["-m", "600", fifo]);
    // In a child with a timeout: before O_NONBLOCK, openSync blocked forever here.
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `
      const mod = await import(${JSON.stringify(secretModUrl)});
      try { mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: process.argv[1] }); process.stdout.write("loaded"); }
      catch (e) { process.stdout.write((e instanceof mod.StateSecretFileError ? "refused:" : "other:") + e.message); }
    `, fifo], { encoding: "utf8", timeout: 5000 });
    assert.equal(r.signal, null, "loadStateSecret hung on the FIFO");
    assert.match(r.stdout, /^refused:.*not a regular file/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("one trailing newline is stripped; a BOM, other whitespace or extra newlines are refused", () => {
  const dir = tmp();
  try {
    for (const [name, data] of [["nl", SECRET + "\n"], ["crlf", SECRET + "\r\n"], ["bare", SECRET]] as const) {
      assert.equal(mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: rawFile(dir, name, data) }).secret, SECRET, name);
    }
    const bad: Array<[string, string | Buffer]> = [
      ["bom", "\ufeff" + SECRET], ["bom-bytes", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(SECRET + "\n")])],
      ["lead-space", " " + SECRET], ["lead-tab", "\t" + SECRET], ["lead-nl", "\n" + SECRET],
      ["trail-space", SECRET + " "], ["trail-space-nl", SECRET + " \n"], ["two-nl", SECRET + "\n\n"],
      ["trail-cr", SECRET + "\r"], ["trail-tab", SECRET + "\t\n"], ["nbsp", SECRET + "\u00a0"],
    ];
    for (const [name, data] of bad) {
      assert.throws(() => mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: rawFile(dir, name, data) }),
        (e: Error) => e instanceof mod.StateSecretFileError && !e.message.includes(SECRET), name);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a secret shorter than 32 characters fails fast at load, from a file or the env var", () => {
  const dir = tmp();
  try {
    const short = "s".repeat(31);
    assert.equal(mod.MIN_STATE_SECRET_LENGTH, 32);
    assert.throws(() => mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: rawFile(dir, "short", short + "\n") }), (e: Error) => e instanceof mod.StateSecretFileError && /at least 32/.test(e.message) && !e.message.includes(short));
    const env: Record<string, string> = { ZYRON_TESTNET_STATE_SECRET: short };
    assert.throws(() => mod.loadStateSecret(env), (e: Error) => e instanceof mod.StateSecretFileError && /at least 32/.test(e.message));
    assert.equal(env.ZYRON_TESTNET_STATE_SECRET, undefined, "deleted from env even when refused");
    assert.equal(mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET_FILE: rawFile(dir, "exact", "s".repeat(32)) }).secret, "s".repeat(32));
    assert.equal(mod.loadStateSecret({ ZYRON_TESTNET_STATE_SECRET: "s".repeat(32) }).secret, "s".repeat(32));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
