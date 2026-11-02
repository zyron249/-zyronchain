// Validators are started with a bounded V8 old generation so their RSS does
// not creep up on the 512 MB open-testnet host.
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);

test("validators get the default old-space cap", () => {
  assert.deepEqual(api.validatorNodeFlags({}), [`--max-old-space-size=${api.VALIDATOR_MAX_OLD_MB_DEFAULT}`]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "" }), [`--max-old-space-size=${api.VALIDATOR_MAX_OLD_MB_DEFAULT}`]);
  // Measured live heap is ~27 MB; the cap must stay well under the 512 MB host.
  assert.ok(api.VALIDATOR_MAX_OLD_MB_DEFAULT === 96);
});

test("ZYRON_VALIDATOR_MAX_OLD_MB overrides the cap, and 0 disables it", () => {
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "96" }), ["--max-old-space-size=96"]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "0" }), []);
});

test("invalid or out-of-range values fall back to the default", () => {
  for (const raw of ["abc", "-5", "8", "31", "4097", "12.5", "100000", "64; rm", " 96", "96 ", "+96", "0x60", "1e2", "96MB", "١٢٣"]) {
    assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: raw }), [`--max-old-space-size=${api.VALIDATOR_MAX_OLD_MB_DEFAULT}`], raw);
  }
});

test("the 32..4096 bounds are inclusive and leading zeros are digits", () => {
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "32" }), ["--max-old-space-size=32"]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "4096" }), ["--max-old-space-size=4096"]);
  assert.deepEqual(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "064" }), ["--max-old-space-size=64"]);
});

function clock(start = 1_000_000) { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; }

test("restart backoff doubles from 5 s to a 5 min cap", () => {
  const c = clock(); const sup = api.createValidatorSupervisor({ now: c.now });
  const delays: number[] = [];
  for (let i = 0; i < 9; i++) { sup.started("v1"); c.advance(1_000); delays.push(sup.exited("v1", { code: 1, signal: null })); sup.restarting("v1"); }
  assert.deepEqual(delays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
  assert.equal(sup.status("v1").restarts, 9);
});

test("backoff resets after a stable run of 10 min, the restart count does not", () => {
  const c = clock(); const sup = api.createValidatorSupervisor({ now: c.now });
  for (let i = 0; i < 3; i++) { sup.started("v2"); c.advance(1_000); sup.exited("v2", { code: 1 }); sup.restarting("v2"); }
  sup.started("v2"); c.advance(api.VALIDATOR_RESTART_STABLE_MS - 1);
  assert.equal(sup.exited("v2", { code: 1 }), 40_000);
  sup.restarting("v2"); sup.started("v2"); c.advance(api.VALIDATOR_RESTART_STABLE_MS);
  assert.equal(sup.exited("v2", { code: 1 }), 5_000);
  assert.equal(sup.status("v2").restarts, 4);
});

test("restart counts are per validator", () => {
  const c = clock(); const sup = api.createValidatorSupervisor({ now: c.now });
  sup.started("v1"); sup.exited("v1", { code: 1 }); sup.restarting("v1");
  assert.equal(sup.status("v1").restarts, 1);
  assert.deepEqual(sup.status("v3"), { restarts: 0, lastExitCode: null, lastExitSignal: null, lastExitAt: null, lastExitReason: null });
  sup.started("v3"); c.advance(10);
  assert.equal(sup.exited("v3", { code: 1 }), 5_000);
});

test("exit reasons: SIGABRT (V8 heap OOM) is oom, other signals are signal, codes are exit", () => {
  assert.equal(api.classifyValidatorExit(null, "SIGABRT"), "oom");
  assert.equal(api.classifyValidatorExit(134, null), "oom");
  assert.equal(api.classifyValidatorExit(null, "SIGKILL"), "signal");
  assert.equal(api.classifyValidatorExit(1, null), "exit");
  assert.equal(api.classifyValidatorExit(0, null), "exit");
});

test("/health validator entries carry restarts and the last exit, labelled oom for SIGABRT", () => {
  const c = clock(Date.UTC(2026, 10, 2, 16, 0, 0)); const sup = api.createValidatorSupervisor({ now: c.now });
  sup.started("v1"); c.advance(2_000); sup.exited("v1", { code: null, signal: "SIGABRT" }); sup.restarting("v1");
  sup.started("v2"); c.advance(1_000); sup.exited("v2", { code: 1, signal: null }); sup.restarting("v2");
  const out = api.withSupervisorStatus([{ name: "v1", up: true, height: 5 }, { name: "v2", up: false }, { name: "v3", up: true }], sup);
  assert.deepEqual(out[0], { name: "v1", up: true, height: 5, restarts: 1, lastExitCode: null, lastExitSignal: "SIGABRT", lastExitAt: "2026-11-02T16:00:02.000Z", lastExitReason: "oom" });
  assert.equal(out[1].lastExitReason, "exit"); assert.equal(out[1].lastExitCode, 1); assert.equal(out[1].restarts, 1);
  assert.equal(out[2].restarts, 0); assert.equal(out[2].lastExitReason, null);
});

test("maxOldSpaceMb is the cap actually passed, or null when off", () => {
  assert.equal(api.maxOldSpaceMbFromFlags(api.validatorNodeFlags({})), 96);
  assert.equal(api.maxOldSpaceMbFromFlags(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "128" })), 128);
  assert.equal(api.maxOldSpaceMbFromFlags(api.validatorNodeFlags({ ZYRON_VALIDATOR_MAX_OLD_MB: "0" })), null);
});

const MB = 1048576;
const report = { type: "zyron-validator-memory", rss: 120 * MB, heapTotal: 60 * MB, heapUsed: 30.04 * MB, external: 3 * MB, arrayBuffers: 0.5 * MB };

test("validator memory: reported fields in MB, null before the first report", () => {
  const c = clock(); const t = api.createValidatorMemoryTracker({ now: c.now });
  t.started("v1", 96);
  assert.deepEqual(t.status("v1"), { maxOldSpaceMb: 96, heapUsedMb: null, heapTotalMb: null, rssMb: null, externalMb: null, arrayBuffersMb: null, memoryReportedAt: null, memoryDropped: { oversized: 0, malformed: 0 } });
  assert.equal(t.message("v1", report), true);
  assert.deepEqual(t.status("v1"), { maxOldSpaceMb: 96, heapUsedMb: 30, heapTotalMb: 60, rssMb: 120, externalMb: 3, arrayBuffersMb: 0.5, memoryReportedAt: new Date(c.now()).toISOString(), memoryDropped: { oversized: 0, malformed: 0 } });
  t.started("v2", null);
  assert.equal(t.status("v2").maxOldSpaceMb, null);
  const [row] = api.withValidatorMemory([{ name: "v1", up: true }], t);
  assert.equal(row.up, true); assert.equal(row.rssMb, 120);
});

test("validator memory: a sample older than 2 minutes reads as null", () => {
  const c = clock(); const t = api.createValidatorMemoryTracker({ now: c.now });
  t.started("v1", 96); t.message("v1", report);
  c.advance(120_000); assert.equal(t.status("v1").rssMb, 120);
  c.advance(1); assert.equal(t.status("v1").rssMb, null); assert.equal(t.status("v1").memoryReportedAt, null);
  assert.equal(t.status("v1").maxOldSpaceMb, 96);
});

test("validator memory: a restart drops the old sample; bad messages are ignored", () => {
  const c = clock(); const t = api.createValidatorMemoryTracker({ now: c.now });
  t.started("v1", 96); t.message("v1", report);
  t.started("v1", 96); assert.equal(t.status("v1").rssMb, null);
  for (const bad of [null, "x", {}, { ...report, type: "other" }, { ...report, rss: "1" }, { ...report, rss: -1 }, { ...report, rss: Infinity }, { ...report, heapUsed: undefined }, { ...report, rss: 2 ** 46 }]) assert.equal(t.message("v1", bad), false);
  assert.equal(t.status("v1").rssMb, null);
  assert.equal(t.message("unknown", report), false);
  // Names are bounded.
  const b = api.createValidatorMemoryTracker({ maxNames: 2 });
  b.started("a", 1); b.started("b", 1); b.started("c", 1);
  assert.equal(b.message("c", report), false);
});

// Spawns a child the way runNetwork spawns a validator (preload, fd 3 pipe,
// validatorChildEnv) and wires the gateway-side reader and tracker.
async function spawnLikeGateway(code: string, ms: number) {
  const { spawn } = await import("node:child_process");
  const t = api.createValidatorMemoryTracker(); t.started("v1", null);
  const reader = api.createMemoryLineReader((msg: unknown) => t.message("v1", msg));
  t.reader("v1", reader.stats);
  const child = spawn(process.execPath, ["--require", api.VALIDATOR_MEMORY_PRELOAD, "-e", code], { stdio: ["ignore", "ignore", "inherit", "pipe"], env: api.validatorChildEnv() });
  const pipe: any = child.stdio[api.VALIDATOR_MEMORY_FD];
  let peakRss = process.memoryUsage().rss; const rss0 = peakRss;
  pipe.on("data", (chunk: Buffer) => { reader.push(chunk); peakRss = Math.max(peakRss, process.memoryUsage().rss); });
  pipe.on("error", () => {});
  const exit: Promise<number | null> = new Promise((done) => child.once("exit", done));
  await new Promise((done) => setTimeout(done, ms));
  child.kill(); await exit;
  return { t, reader, rssGrowthMb: (peakRss - rss0) / 1048576 };
}

test("the preload reports process.memoryUsage over the fd 3 pipe and does not keep the child alive", async () => {
  const { spawn } = await import("node:child_process");
  const t = api.createValidatorMemoryTracker(); t.started("v1", null);
  const reader = api.createMemoryLineReader((msg: unknown) => t.message("v1", msg));
  const child = spawn(process.execPath, ["--require", api.VALIDATOR_MEMORY_PRELOAD, "-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "ignore", "inherit", "pipe"], env: api.validatorChildEnv() });
  const pipe: any = child.stdio[api.VALIDATOR_MEMORY_FD];
  const first = new Promise((done) => pipe.on("data", (chunk: Buffer) => { reader.push(chunk); if (reader.stats.lines) done(null); }));
  await first;
  assert.ok(t.status("v1").rssMb > 0 && t.status("v1").heapUsedMb > 0);
  assert.equal(reader.stats.malformed, 0);
  const code = await new Promise((done) => child.once("exit", done));
  assert.equal(code, 0);
});

test("validator child env sets MALLOC_ARENA_MAX=2 (an explicit value wins) and the memory fd", () => {
  const env = api.validatorChildEnv({ PATH: "/bin" });
  assert.equal(env.MALLOC_ARENA_MAX, "2"); assert.equal(env.PATH, "/bin"); assert.equal(env.ZYRON_VALIDATOR_MEMORY_FD, "3");
  assert.equal(api.validatorChildEnv({ MALLOC_ARENA_MAX: "4" }).MALLOC_ARENA_MAX, "4");
});

test("memory line reader: malformed, oversized and split lines never throw and are counted", () => {
  const got: unknown[] = [];
  const r = api.createMemoryLineReader((m: unknown) => { got.push(m); return true; }, { maxLineBytes: 64 });
  r.push(Buffer.from("not json\n{\"a\":"));
  r.push(Buffer.from("1}\n\n"));
  r.push(Buffer.from("x".repeat(50))); r.push(Buffer.from("y".repeat(50))); r.push(Buffer.from("z\n{\"b\":2}\n"));
  r.push("{\"__proto__\":{\"p\":1}}\n");
  assert.deepEqual(got.slice(0, 2), [{ a: 1 }, { b: 2 }]);
  assert.equal(r.stats.malformed, 1); assert.equal(r.stats.oversized, 1);
  assert.equal(({} as any).p, undefined);
  const throwing = api.createMemoryLineReader(() => { throw new Error("boom"); });
  throwing.push("{}\n"); assert.equal(throwing.stats.malformed, 1);
});

// Security PoC /workspace/zr-poc/1183 Q2-Q4, against the new channel.
test("PoC Q2: a raw non-JSON line on fd 3 is dropped and counted; the gateway stays up", async () => {
  let crashed: unknown = null; const onCrash = (e: unknown) => { crashed = e; };
  process.on("uncaughtException", onCrash);
  try {
    const { t, reader } = await spawnLikeGateway("require('fs').writeSync(3,'not json\\n');setTimeout(()=>{},3000)", 1800);
    assert.equal(crashed, null);
    assert.ok(reader.stats.malformed >= 1);
    assert.ok(t.status("v1").memoryDropped.malformed >= 1);
    assert.ok(t.status("v1").rssMb > 0, "valid reports still accepted");
  } finally { process.off("uncaughtException", onCrash); }
});

test("PoC Q3: one 200 MB line is dropped and counted without growing gateway RSS", async () => {
  const { t, reader, rssGrowthMb } = await spawnLikeGateway("const s='x'.repeat(2e8);require('fs').writeSync(3,JSON.stringify({type:'zyron-validator-memory',pad:s})+'\\n');setTimeout(()=>{},5000)", 4000);
  assert.equal(reader.stats.oversized, 1);
  assert.equal(t.status("v1").memoryDropped.oversized, 1);
  assert.ok(rssGrowthMb < 100, `gateway RSS grew ${rssGrowthMb.toFixed(0)} MB`);
});

test("PoC Q4: a 2 s flood of lines is parsed, rejected and bounded", async () => {
  const { t, reader, rssGrowthMb } = await spawnLikeGateway("const fs=require('fs');const e=Date.now();const l=JSON.stringify({type:'x'})+'\\n';const b=l.repeat(500);(function f(){try{fs.writeSync(3,b)}catch{}if(Date.now()-e<1500)setImmediate(f)})();setTimeout(()=>{},3000)", 2500);
  assert.ok(reader.stats.lines > 1000, `lines ${reader.stats.lines}`);
  assert.ok(t.status("v1").memoryDropped.malformed > 1000);
  assert.ok(rssGrowthMb < 100, `gateway RSS grew ${rssGrowthMb.toFixed(0)} MB`);
});
