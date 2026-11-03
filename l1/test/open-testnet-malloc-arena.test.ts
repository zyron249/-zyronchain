// The gateway re-execs itself in place with MALLOC_ARENA_MAX=2 (glibc reads it
// only at process start), unless one is set explicitly.
import assert from "node:assert/strict";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const modPath = join(l1Root, "scripts/open-testnet/malloc-arena.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ma: any = await import(pathToFileURL(modPath).href);
const execve = () => {};

test("plan: unset -> re-exec with 2 and the same argv; explicit value, non-Linux or no execve -> none", () => {
  const plan = ma.mallocArenaReexecPlan({ env: { A: "1" }, platform: "linux", execve, execPath: "/n", execArgv: ["--x"], argv: ["/n", "s.mjs", "run", "--dir", "d"] });
  assert.deepEqual(plan, { file: "/n", args: ["/n", "--x", "s.mjs", "run", "--dir", "d"], env: { A: "1", MALLOC_ARENA_MAX: "2" } });
  assert.equal(ma.mallocArenaReexecPlan({ env: { MALLOC_ARENA_MAX: "4" }, platform: "linux", execve }), undefined);
  assert.notEqual(ma.mallocArenaReexecPlan({ env: { MALLOC_ARENA_MAX: "" }, platform: "linux", execve }), undefined, "empty counts as unset");
  assert.equal(ma.mallocArenaReexecPlan({ env: {}, platform: "darwin", execve }), undefined);
  assert.equal(ma.mallocArenaReexecPlan({ env: {}, platform: "linux", execve: null }), undefined);
});

const probe = `import { ensureGatewayMallocArena } from ${JSON.stringify(pathToFileURL(modPath).href)};
import { readFileSync } from "node:fs";
if (!process.env.PROBE_PID) process.env.PROBE_PID = String(process.pid);
ensureGatewayMallocArena({}, () => {});
const initial = readFileSync("/proc/self/environ", "latin1").split("\\0").filter((e) => e.startsWith("MALLOC_ARENA_MAX="));
console.log(JSON.stringify({ samePid: process.env.PROBE_PID === String(process.pid), initial }));`;

test("re-exec in place: /proc/<pid>/environ of the same pid carries MALLOC_ARENA_MAX=2", { skip: process.platform !== "linux" || typeof (process as any).execve !== "function" }, () => {
  const env = { PATH: process.env.PATH ?? "" };
  const out = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8" });
  assert.equal(out.status, 0, out.stderr);
  // --input-type/-e are execArgv, so the re-exec'd process runs the same probe.
  assert.deepEqual(JSON.parse(out.stdout.trim()), { samePid: true, initial: ["MALLOC_ARENA_MAX=2"] });
  const kept = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env: { ...env, MALLOC_ARENA_MAX: "8" }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(kept.stdout.trim()), { samePid: true, initial: ["MALLOC_ARENA_MAX=8"] });
});

// Security Info (#1196 vs #1188): in the "run" command, ensureGatewayMallocArena
// must stay the first step, before the state secret is read (loadStateSecret
// in #1188, or a direct read of the env var), so the secret is loaded once in
// the re-executed process.
test("run order: ensureGatewayMallocArena runs before any state-secret read", async () => {
  const { readFile } = await import("node:fs/promises");
  const src = await readFile(join(l1Root, "scripts/open-testnet.mjs"), "utf8");
  const start = src.indexOf('} else if (command === "run") {');
  assert.ok(start > 0, "run branch found");
  const next = src.indexOf("} else if (command ===", start + 1);
  const run = src.slice(start, next > 0 ? next : undefined).split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  const arena = run.indexOf("ensureGatewayMallocArena();");
  assert.ok(arena > 0, "run calls ensureGatewayMallocArena");
  const firstStep = run.slice(run.indexOf("{") + 1, arena).split("\n").filter((l) => l.trim());
  assert.deepEqual(firstStep, [], "nothing runs before it in the run branch");
  for (const marker of ["loadStateSecret(", "ZYRON_TESTNET_STATE_SECRET", "stateSecret"]) {
    const at = run.indexOf(marker);
    if (at >= 0) assert.ok(at > arena, `${marker} comes after ensureGatewayMallocArena`);
  }
});
