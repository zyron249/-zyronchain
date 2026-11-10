// #1210 follow-up to #1200 (Security r3 R3-3, Red Team retest R2-1/R2-3/R2-6):
// - faucetIp gets the 256-per-/48 cap and its quota is taken only after the
//   request body validates;
// - a /48 at its cap evicts its own oldest key on the 60s tables, and on the
//   deny tables gets a Retry-After at that key's expiry;
// - /health splits deniedPrefix/evictedPrefix from deniedFull/evicted and
//   reports a fill level, with one log line at 80% and one at full;
// - per-/48 accounting stays consistent through eviction and expiry (fuzz).
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const identity: any = await import(pathToFileURL(join(l1Root, "dist", "src", "rpc-client-identity.js")).href);
const bucket = (address: string): string => identity.clientAddressBucket(address);
const hex = (n: number) => n.toString(16);
const v6 = (a: number, b: number) => `ipv6:2001:0db8:${hex(a).padStart(4, "0")}:${hex(b).padStart(4, "0")}/64`;
const DAY = 86_400_000;
const ADDRESS = `ZYN${"a".repeat(40)}`;
const ALLOWED = new Set<string>(api.DEFAULT_FAUCET_ALLOWED_ORIGINS);

test("R2-1: a /48 spray on a 60s table only churns its own keys; a neighbour /64 in that /48 is admitted on its first request", () => {
  const l = new api.WindowLimiter(240, 60_000, 10_000, { evictOnFull: true, prefixCap: 256 });
  const other = v6(2, 1);
  assert.equal(l.take(other, 0).allowed, true);
  let attackerKey = 0;
  let neighbourServed = 0;
  let neighbourTried = 0;
  // 200 s at 1000 new attacker /64s per second from 2001:db8:aa::/48, plus a
  // fresh neighbour /64 from the same /48 every 5 s.
  for (let t = 0; t < 200_000; t += 10) {
    for (let i = 0; i < 10; i += 1) l.take(v6(0xaa, attackerKey++ % 0xfff0), t);
    if (t % 1_000 === 0) assert.equal(l.take(other, t).allowed, true, `other /48 served at ${t}`);
    if (t % 5_000 === 0) {
      neighbourTried += 1;
      if (l.take(v6(0xaa, 0xfff1 + (neighbourTried % 14)), t).allowed) neighbourServed += 1;
    }
  }
  assert.equal(neighbourServed, neighbourTried, "every neighbour request served (was 2.4-7.1% at dce95712)");
  assert.equal(l.perPrefix.get("2001:0db8:00aa::/48").size, 256, "the /48 never exceeds its cap");
  assert.ok(l.hits.has(other), "a key from another /48 is never pushed out by the /48 spray");
  assert.equal(l.hits.size, 257);
  assert.equal(l.stats().evicted, 0, "no table-wide eviction: the spray is contained in its /48");
  assert.ok(l.stats().evictedPrefix > 100_000);
  assert.equal(l.stats().deniedPrefix, 0);
  assert.equal(l.stats().deniedFull, 0);
});

test("R2-1: on a deny table (faucetIp style) a /48 at its cap is denied with Retry-After at its oldest key's expiry, then re-opens", () => {
  const l = new api.WindowLimiter(5, DAY, 50_000, { prefixCap: 256 });
  for (let i = 0; i < 256; i += 1) assert.equal(l.take(v6(1, i), 1_000 + i).allowed, true);
  const denied = l.take(v6(1, 999), 10_000);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterMs, 1_000 + DAY - 10_000, "Retry-After is the /48's oldest key's expiry, not a fixed full window");
  assert.equal(l.hits.has(v6(1, 999)), false);
  assert.equal(l.stats().deniedPrefix, 1);
  assert.equal(l.stats().deniedFull, 0, "a /48-cap denial is not a table-full denial");
  assert.equal(l.stats().evictedPrefix, 0, "the deny table never evicts, so a /48 cannot reset day quotas");
  // Another /48 and IPv4 are unaffected.
  assert.equal(l.take(v6(2, 0), 10_001).allowed, true);
  assert.equal(l.take(bucket("198.51.100.7"), 10_002).allowed, true);
  // At the advertised moment the oldest key expires and exactly one slot frees.
  assert.equal(l.take(v6(1, 999), 1_000 + DAY - 1).allowed, false);
  assert.equal(l.take(v6(1, 999), 1_000 + DAY).allowed, true);
  assert.equal(l.take(v6(1, 998), 1_000 + DAY).allowed, false);
});

test("R2-3: /health counters split /48-cap events from table-full events and report the fill level", () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  for (const name of ["read", "write", "relayIp", "faucetIp", "faucetAddress", "faucetAttempt", "faucetGlobal", "snapshot"]) {
    const s = limits[name].stats();
    for (const field of ["size", "maxKeys", "deniedFull", "deniedPrefix", "evicted", "evictedPrefix"]) assert.equal(typeof s[field], "number", `${name}.${field}`);
  }
  for (const name of ["read", "write", "relayIp", "faucetIp", "faucetAddress", "faucetAttempt"]) {
    assert.equal(limits[name].stats().fill, "ok", name);
    assert.equal(limits[name].stats().fillAlerts, 0, name);
  }
  // Single-key global tables are always "full" by design and carry no fill alert.
  assert.equal("fill" in limits.faucetGlobal.stats(), false);
  assert.equal("fill" in limits.snapshot.stats(), false);
  // R3-3 wiring: faucetIp is capped per /48 and stays deny-on-full.
  assert.equal(limits.faucetIp.prefixCap, api.RATE_LIMITER_PREFIX_CAP_DEFAULT);
  assert.equal(limits.faucetIp.evictOnFull, false);
  assert.equal(limits.faucetIp.maxKeys, api.DAY_WINDOW_LIMITER_MAX_KEYS);
  assert.equal(limits.faucetAddress.prefixCap, 0);
  for (const name of ["read", "write", "relayIp"]) assert.equal(limits[name].prefixCap, 256, name);
  const body = api.rateLimitersHealth(limits);
  assert.deepEqual(Object.keys(body).sort(), ["faucetAddress", "faucetAttempt", "faucetGlobal", "faucetIp", "faucetPrefix", "read", "relayIp", "snapshot", "write"]);
});

test("R2-3: one fill log line at 80% and one at full, re-armed only below 70%; the line carries counts, never keys", () => {
  const events: Array<{ level: string; size: number }> = [];
  const l = new api.WindowLimiter(10, 60_000, 10, { evictOnFull: true, fillAlert: true, onFill: (info: { level: string; size: number }) => events.push(info) });
  for (let i = 0; i < 7; i += 1) l.take(`198.51.100.${i}`, i);
  assert.equal(events.length, 0);
  assert.equal(l.stats().fill, "ok");
  l.take("198.51.100.7", 7);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.level, "high");
  assert.equal(events[0]!.size, 8);
  assert.equal(l.stats().fill, "high");
  l.take("198.51.100.8", 8);
  l.take("198.51.100.9", 9);
  assert.equal(events.length, 2);
  assert.equal(events[1]!.level, "full");
  // Staying full while evicting does not repeat the line.
  for (let i = 10; i < 100; i += 1) l.take(`198.51.100.${i}`, 10);
  assert.equal(events.length, 2);
  assert.equal(l.stats().fillAlerts, 2);
  // Every key expires by t=70_000; the table drops below 70% and re-arms, so
  // climbing back to 80% logs again.
  l.take("203.0.113.1", 70_000);
  assert.equal(l.stats().size, 1);
  assert.equal(l.stats().fill, "ok");
  for (let i = 2; i <= 8; i += 1) l.take(`203.0.113.${i}`, 70_000);
  assert.equal(events.length, 3, "re-armed after dropping below 70%");
  assert.equal(events[2]!.level, "high");
  const line = api.rateLimiterFillLine("read", events[1]);
  assert.match(line, /^rate limiter read: full \(10\/10 keys; deniedFull=0 deniedPrefix=0 evicted=\d+ evictedPrefix=0\)$/);
  assert.equal(/198\.51|203\.0|ipv6|2001/.test(line), false);
  // createGatewayLimits wires the log callback.
  const logs: string[] = [];
  const limits = api.createGatewayLimits({ env: { ZYRON_RPC_LIMITER_MAX_KEYS: "1000" }, log: (s: string) => logs.push(s) });
  for (let i = 0; i < 800; i += 1) limits.read.take(bucket(`198.18.${i >> 8}.${i & 255}`), 0);
  assert.deepEqual(logs, ["rate limiter read: at 80% (800/1000 keys; deniedFull=0 deniedPrefix=0 evicted=0 evictedPrefix=0)"]);
  // A deny-on-full table logs "full" when it starts refusing.
  const deny = new api.WindowLimiter(1, DAY, 5, { fillAlert: true, onFill: (info: { level: string; size: number }) => events.push(info) });
  for (let i = 0; i < 6; i += 1) deny.take(`k${i}`, i);
  assert.deepEqual(events.slice(3).map((e) => e.level), ["high", "full"]);
  assert.equal(deny.stats().deniedFull, 1);
});

// R2-6: per-/48 sets must always equal the /48 grouping of the live keys,
// through table-full eviction, /48 eviction, expiry, renewal and denial.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function checkConsistent(l: any, cap: number, where: string) {
  const expected = new Map<string, string[]>();
  for (const k of l.hits.keys()) {
    const p = l.prefixCap > 0 ? api.rateLimiterIpv6Prefix48(k) : undefined;
    if (p) expected.set(p, [...(expected.get(p) ?? []), k]);
  }
  assert.equal(l.perPrefix.size, expected.size, `${where}: prefix count`);
  for (const [p, keys] of expected) {
    const live = l.perPrefix.get(p);
    assert.ok(live, `${where}: missing ${p}`);
    assert.deepEqual([...live], keys, `${where}: ${p} keys and order`);
    assert.ok(live.size <= cap, `${where}: ${p} over cap`);
  }
}

test("R2-6: per-/48 accounting is consistent through eviction and expiry, and the cap re-opens after the window", () => {
  const l = new api.WindowLimiter(3, 1_000, 6, { evictOnFull: true, prefixCap: 3 });
  for (let i = 0; i < 3; i += 1) l.take(v6(1, i), i);
  checkConsistent(l, 3, "fill /48 1");
  l.take(v6(1, 3), 3); // /48 eviction of v6(1,0)
  assert.deepEqual([...l.perPrefix.get("2001:0db8:0001::/48")], [v6(1, 1), v6(1, 2), v6(1, 3)]);
  for (let i = 0; i < 3; i += 1) l.take(v6(2, i), 10 + i);
  checkConsistent(l, 3, "table full");
  l.take(bucket("198.51.100.1"), 20); // table-full eviction of the global oldest, v6(1,1)
  assert.equal(l.stats().evicted, 1);
  assert.deepEqual([...l.perPrefix.get("2001:0db8:0001::/48")], [v6(1, 2), v6(1, 3)]);
  checkConsistent(l, 3, "after table eviction");
  l.take(v6(1, 2), 1_002); // v6(1,2) expired and renews at the back of its /48
  checkConsistent(l, 3, "after renewal");
  l.take(bucket("198.51.100.2"), 5_000); // everything else expires
  assert.equal(l.perPrefix.size, 0);
  assert.equal(l.hits.size, 1);
  for (let i = 10; i < 13; i += 1) assert.equal(l.take(v6(1, i), 5_001).allowed, true, "cap re-opened after the window");
  checkConsistent(l, 3, "re-opened");
  // A deny table: the /48 re-opens once its oldest key expires.
  const d = new api.WindowLimiter(1, 1_000, 100, { prefixCap: 2 });
  d.take(v6(5, 0), 0); d.take(v6(5, 1), 500);
  assert.equal(d.take(v6(5, 2), 600).retryAfterMs, 400);
  assert.equal(d.take(v6(5, 2), 1_000).allowed, true);
  checkConsistent(d, 2, "deny re-open");
  // Tables without a cap never track prefixes.
  const f = new api.WindowLimiter(5, DAY, 3);
  for (let i = 0; i < 10; i += 1) f.take(v6(3, i), i);
  assert.equal(f.perPrefix.size, 0);
});

test("R2-6: fuzz (port of Red Team D2): random takes keep per-/48 sets exact, never over cap, empty after full expiry", () => {
  let seed = 7;
  const r = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const configs = [
    { max: 50, cap: 8, evictOnFull: true },
    { max: 50, cap: 2, evictOnFull: true },
    { max: 500, cap: 64, evictOnFull: true },
    { max: 2_000, cap: 256, evictOnFull: true },
    { max: 50, cap: 8, evictOnFull: false },
    { max: 500, cap: 64, evictOnFull: false }
  ];
  for (const cfg of configs) {
    const l = new api.WindowLimiter(5, 1_000, cfg.max, { evictOnFull: cfg.evictOnFull, prefixCap: cfg.cap, fillAlert: true });
    let t = 0;
    for (let i = 0; i < 60_000; i += 1) {
      t += Math.floor(r() * 3);
      const c = r();
      const k = c < 0.6 ? bucket(`2001:db8:${hex(Math.floor(r() * 12))}:${hex(Math.floor(r() * 300))}::1`)
        : c < 0.9 ? bucket(`198.18.0.${Math.floor(r() * 200)}`)
          : `proxy:${bucket("2001:db8:9::1")}`;
      const predicted = l.peek(k, t);
      const res = l.take(k, t);
      assert.deepEqual(predicted, res, `peek must predict take (${JSON.stringify(cfg)} @${i})`);
      if (!res.allowed) assert.ok(res.retryAfterMs > 0 && res.retryAfterMs <= 1_000, `retryAfter ${res.retryAfterMs}`);
      assert.ok(l.hits.size <= cfg.max);
      if (i % 997 === 0) checkConsistent(l, cfg.cap, `${JSON.stringify(cfg)} @${i}`);
    }
    checkConsistent(l, cfg.cap, `${JSON.stringify(cfg)} end`);
    l.take(bucket("198.18.0.1"), t + 10_000);
    assert.equal(l.perPrefix.size, 0, "perPrefix empty after full expiry");
    assert.equal(l.hits.size, 1);
    const s = l.stats();
    // The small-cap configs must actually exercise the /48 path.
    if (cfg.evictOnFull) { if (cfg.cap <= 8) assert.ok(s.evictedPrefix > 0, JSON.stringify(s)); if (cfg.cap <= 2) assert.ok(s.deniedPrefix > 0, `budget exercised ${JSON.stringify(s)}`); assert.equal(s.deniedFull, 0); assert.ok(l.prefixBudget.size <= cfg.max); }
    else { if (cfg.cap <= 8) assert.ok(s.deniedPrefix > 0, JSON.stringify(s)); assert.equal(s.evictedPrefix, 0); assert.equal(s.evicted, 0); }
  }
});

test("peek is read-only and predicts take: exhausted key, capped /48 and full table on deny tables", () => {
  const l = new api.WindowLimiter(2, 1_000, 3, { prefixCap: 1 });
  assert.equal(l.peek("a", 0).allowed, true);
  assert.equal(l.hits.size, 0);
  l.take("a", 0); l.take("a", 1);
  assert.deepEqual(l.peek("a", 100), { allowed: false, retryAfterMs: 900 });
  assert.equal(l.peek("a", 1_000).allowed, true, "expired window");
  l.take(v6(1, 0), 200);
  assert.deepEqual(l.peek(v6(1, 1), 300), { allowed: false, retryAfterMs: 900 }, "capped /48 on a deny table");
  assert.deepEqual(l.take(v6(1, 1), 300), { allowed: false, retryAfterMs: 900 });
  l.take("b", 400);
  assert.deepEqual(l.peek("c", 500), { allowed: false, retryAfterMs: 1_000 }, "full deny table");
  assert.equal(l.peek("c", 1_000).allowed, true, "front entry expired: take will make room");
  assert.equal(l.take("c", 1_000).allowed, true);
  const before = JSON.stringify(l.stats());
  for (let i = 0; i < 50; i += 1) l.peek(`x${i}`, 1_001);
  assert.equal(JSON.stringify(l.stats()), before, "peek changes no counters");
});

test("refund undoes one allowed take (by its receipt) and frees an unused key's slot", () => {
  const l = new api.WindowLimiter(1, DAY, 2, { prefixCap: 1 });
  const first = l.takeWithReceipt(v6(1, 0), 0);
  assert.equal(first.allowed, true);
  assert.equal(l.take(v6(1, 1), 1).allowed, false, "/48 capped");
  assert.equal(l.refund(first.receipt, 2), true);
  assert.equal(l.hits.size, 0);
  assert.equal(l.perPrefix.size, 0);
  assert.equal(l.take(v6(1, 1), 3).allowed, true, "slot freed by the refund");
  assert.equal(l.refund(first.receipt, 4), false, "a receipt refunds at most once");
  assert.equal(l.refund(undefined, 4), false);
  assert.equal("receipt" in l.take("z", 5), false, "take() itself returns no receipt");
});

// ---- R3-3: faucet route takes the per-IP quota only after the body validates.
async function faucetGateway(faucetIp: unknown, ip: () => string) {
  const state = { reads: 0, sends: 0 };
  async function readJsonBody(request: IncomingMessage) {
    state.reads += 1;
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) { size += (chunk as Buffer).length; if (size > 8 * 1024) throw Object.assign(new Error("request body too large"), { statusCode: 413 }); chunks.push(chunk as Buffer); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
  }
  const open = () => ({ take: () => ({ allowed: true, retryAfterMs: 0 }) });
  const route = api.createFaucetRoute({ origins: ALLOWED, limits: { faucetIp, faucetAddress: open(), faucetGlobal: open() }, faucetAddress: `ZYN${"f".repeat(40)}`, readJsonBody, send: async () => { state.sends += 1; return { txid: "t" }; }, log: () => {} });
  const server: Server = createServer((request, response) => { void route(request, response, ip()); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (body: string) => { const r = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body }); await r.arrayBuffer(); return { status: r.status, retryAfter: r.headers.get("retry-after") }; };
  return { state, post, close: () => new Promise((done) => server.close(done)) };
}

test("R3-3: malformed, oversized or invalid faucet bodies do not spend the per-IP quota; an exhausted IP is refused before its body is read", async () => {
  const limiter = new api.WindowLimiter(5, DAY, 50_000, { prefixCap: 256 });
  const ip = bucket("198.51.100.7");
  const gw = await faucetGateway(limiter, () => ip);
  try {
    const bad = ["{not json", JSON.stringify({ address: "nope" }), JSON.stringify({ address: `ZYN${"f".repeat(40)}` }), JSON.stringify([1]), "x".repeat(9 * 1024)];
    for (let round = 0; round < 4; round += 1) {
      for (const body of bad) {
        const r = await gw.post(body);
        assert.ok(r.status === 400 || r.status === 413, `bad body -> ${r.status}`);
      }
    }
    assert.equal(limiter.hits.has(ip), false, "20 invalid requests took no quota");
    for (let i = 0; i < 5; i += 1) assert.equal((await gw.post(JSON.stringify({ address: ADDRESS }))).status, 200);
    assert.equal(gw.state.sends, 5);
    assert.equal(limiter.hits.get(ip).count, 5);
    const readsBefore = gw.state.reads;
    const limited = await gw.post(JSON.stringify({ address: ADDRESS }));
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.retryAfter) > 86_000);
    assert.equal(gw.state.reads, readsBefore, "exhausted IP refused before the body is read");
    assert.equal((await gw.post("{bad")).status, 429, "exhausted IP is refused even with a bad body");
    assert.equal(gw.state.sends, 5);
  } finally { await gw.close(); }
});

test("R3-3: faucetIp caps an IPv6 /48 at 256 /64s per day; a 257th /64 gets 429 with Retry-After at the oldest /64's expiry", async () => {
  const limiter = api.createGatewayLimits({ env: {}, log: () => {} }).faucetIp;
  let n = 0;
  let current = "";
  const gw = await faucetGateway(limiter, () => current);
  try {
    for (; n < 256; n += 1) {
      current = bucket(`2001:db8:77:${hex(n)}::1`);
      assert.equal((await gw.post(JSON.stringify({ address: ADDRESS }))).status, 200, `/64 ${n}`);
    }
    current = bucket("2001:db8:77:ffff::1");
    const denied = await gw.post(JSON.stringify({ address: ADDRESS }));
    assert.equal(denied.status, 429);
    const retry = Number(denied.retryAfter);
    assert.ok(retry > 86_000 && retry <= 86_400, `retry-after ${retry}`);
    // The capped /48 is refused before its body is read (faucetIp.peek), so
    // even a bad body gets 429 and the refusal costs no body read.
    const reads = gw.state.reads;
    assert.equal((await gw.post("{bad")).status, 429);
    assert.equal(gw.state.reads, reads);
    assert.equal(limiter.stats().deniedPrefix, 2, "both refusals are counted");
    assert.equal(limiter.stats().deniedFull, 0);
    current = bucket("2001:db8:78::1");
    assert.equal((await gw.post(JSON.stringify({ address: ADDRESS }))).status, 200, "another /48 is unaffected");
    current = bucket("198.51.100.9");
    assert.equal((await gw.post(JSON.stringify({ address: ADDRESS }))).status, 200, "IPv4 is unaffected");
    assert.equal(gw.state.sends, 258);
  } finally { await gw.close(); }
});

// ---- #1213-1: per-/48 budget on the 60s tables ------------------------------
// One /48 rotating through 65,536 /64s, using each until refused, at 20
// attempts per ms; count what is served in one full window [60 s, 120 s).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function servedPerWindow(l: any, n = 65_536, attemptsPerMs = 20) {
  let i = 0;
  let ok = 0;
  for (let t = 0; t < 120_000; t += 1) {
    for (let j = 0; j < attemptsPerMs; j += 1) {
      if (l.take(v6(0xaa, i % n), t).allowed) { if (t >= 60_000) ok += 1; } else i += 1;
    }
  }
  return ok;
}

test("#1213-1: one /48 cycling 65,536 /64s is held to 256 x the per-key limit per window on read, write and relayIp", () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  const measured: Record<string, number> = {};
  for (const [name, perKey] of [["read", 240], ["write", 10], ["relayIp", 1200]] as const) {
    assert.equal(limits[name].limit, perKey, `${name} default per-key limit`);
    const fresh = api.createGatewayLimits({ env: {}, log: () => {} })[name];
    const served = servedPerWindow(fresh);
    measured[name] = served;
    assert.ok(served <= 256 * perKey, `${name}: ${served} served from one /48 in a window, bound ${256 * perKey}`);
    assert.ok(served >= 256 * perKey * 0.9, `${name}: the /48 still gets its budget (${served})`);
    assert.ok(fresh.stats().deniedPrefix > 0, `${name}: budget refusals counted in deniedPrefix`);
    assert.equal(fresh.stats().evicted, 0, `${name}: nothing outside the /48 is pushed out`);
  }
  console.log(`#1213-1 measured per /48 per 60s window: ${JSON.stringify(measured)}`);
});

test("#1213-1: a neighbour in a /48 under a budget-draining spray is admitted until the budget is spent, and another /48 is untouched", () => {
  const l = api.createGatewayLimits({ env: {}, log: () => {} }).read;
  const other = v6(2, 1);
  let ok = 0;
  let n = 0;
  let i = 0;
  for (let t = 0; t < 180_000; t += 10) {
    for (let j = 0; j < 20; j += 1) if (!l.take(v6(7, i % 4096), t).allowed) i += 1;
    if (t % 1_000 === 0) assert.equal(l.take(other, t).allowed, true, `other /48 at ${t}`);
    if (t % 1_000 === 0 && t >= 60_000) { n += 1; if (l.take(v6(7, 0x8000 + n), t).allowed) ok += 1; }
  }
  const pct = (100 * ok) / n;
  console.log(`#1213-1 neighbour first-request admit in a draining spray: ${pct.toFixed(1)}% (${ok}/${n})`);
  assert.ok(pct > 30 && pct < 100, `neighbour admit ${pct}%`);
  // Once spent, the whole /48 is refused until its window ends.
  const b = new api.WindowLimiter(2, 1_000, 100, { evictOnFull: true, prefixCap: 2 });
  for (let k = 0; k < 4; k += 1) assert.equal(b.take(v6(9, k >> 1), 10).allowed, true);
  assert.deepEqual(b.take(v6(9, 5), 20), { allowed: false, retryAfterMs: 990 }, "budget 2 x 2 spent: neighbour refused");
  assert.deepEqual(b.peek(v6(9, 6), 20), { allowed: false, retryAfterMs: 990 });
  assert.equal(b.stats().deniedPrefix, 1);
  assert.equal(b.take(v6(9, 5), 1_010).allowed, true, "new window, new budget");
});

test("#1213-1: the per-/48 budget table is bounded by maxKeys and only exists on evicting tables", () => {
  const l = new api.WindowLimiter(5, 60_000, 1_000, { evictOnFull: true, prefixCap: 4 });
  for (let k = 0; k < 5_000; k += 1) l.take(v6(k, 0), k);
  assert.equal(l.prefixBudget.size, 1_000);
  assert.ok(l.hits.size <= 1_000);
  const deny = new api.WindowLimiter(5, DAY, 1_000, { prefixCap: 4 });
  for (let k = 0; k < 100; k += 1) deny.take(v6(k, 0), k);
  assert.equal(deny.prefixBudget.size, 0, "faucetIp-style tables are bounded by the cap itself");
  const ipv4 = new api.WindowLimiter(5, 60_000, 1_000, { evictOnFull: true, prefixCap: 4 });
  for (let k = 0; k < 100; k += 1) ipv4.take(bucket(`198.51.100.${k}`), k);
  assert.equal(ipv4.prefixBudget.size, 0, "IPv4 keys have no /48 budget");
});

// ---- #1213-4 / #1213-5: faucet spends nothing unless every table allows it --
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function faucetWith(limits: any, send: () => Promise<unknown>, ip = "198.51.100.7") {
  const state = { reads: 0, sends: 0 };
  async function readJsonBody(request: IncomingMessage) {
    state.reads += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
  }
  const route = api.createFaucetRoute({ origins: ALLOWED, limits, faucetAddress: `ZYN${"f".repeat(40)}`, readJsonBody, send: async () => { state.sends += 1; return send(); }, log: () => {} });
  const server: Server = createServer((request, response) => { void route(request, response, ip); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (body: string) => { const r = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body }); await r.arrayBuffer(); return r.status; };
  return { state, post, close: () => new Promise((done) => server.close(done)) };
}
// Leading "a" keeps test addresses clear of the reserved ZYN000…0/1/2 range.
const addr = (n: number) => `ZYNa${n.toString(16).padStart(39, "0")}`;

test("#1213-4: when faucetGlobal refuses, faucetIp and faucetAddress are not spent", async () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  for (let i = 0; i < 200; i += 1) limits.faucetGlobal.take("global");
  const gw = await faucetWith(limits, async () => ({ txid: "t" }));
  try {
    for (let i = 0; i < 5; i += 1) assert.equal(await gw.post(JSON.stringify({ address: addr(100 + i) })), 429);
    assert.equal(gw.state.sends, 0);
    assert.equal(limits.faucetIp.hits.size, 0, "no per-IP slot spent");
    assert.equal(limits.faucetAddress.hits.size, 0, "no per-address slot spent");
  } finally { await gw.close(); }
  // A spent address refuses without spending the IP or global quota either.
  const l2 = api.createGatewayLimits({ env: {}, log: () => {} });
  l2.faucetAddress.take(addr(1));
  const gw2 = await faucetWith(l2, async () => ({ txid: "t" }));
  try {
    assert.equal(await gw2.post(JSON.stringify({ address: addr(1) })), 429);
    assert.equal(l2.faucetIp.hits.size, 0);
    assert.equal(l2.faucetGlobal.hits.size, 0);
  } finally { await gw2.close(); }
});

test("#1213-6: only a pre-submit send failure refunds; a node rejection, 5xx or timeout keeps every quota spent", async () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  let mode = "pre";
  const gw = await faucetWith(limits, async () => {
    if (mode === "pre") throw api.markFaucetPreSubmit(new Error("faucet nonce lookup failed (status 502)"));
    if (mode === "rejected") throw new Error("faucet transfer rejected by node (status 400): nope");
    if (mode === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    return { txid: "t" };
  });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal(await gw.post(JSON.stringify({ address: addr(1) })), 503);
    assert.equal(limits.faucetIp.hits.size, 0, "pre-submit failures are refunded");
    assert.equal(limits.faucetAddress.hits.size, 0);
    assert.equal(limits.faucetGlobal.hits.size, 0);
    mode = "rejected";
    assert.equal(await gw.post(JSON.stringify({ address: addr(2) })), 503);
    mode = "timeout";
    assert.equal(await gw.post(JSON.stringify({ address: addr(3) })), 503);
    assert.equal(limits.faucetIp.hits.get("198.51.100.7").count, 2, "node rejection and timeout are not refunded");
    assert.equal(limits.faucetGlobal.hits.get("global").count, 2);
    assert.equal(limits.faucetAddress.hits.has(addr(2)), true);
    assert.equal(limits.faucetAddress.hits.has(addr(3)), true);
    mode = "ok";
    assert.equal(await gw.post(JSON.stringify({ address: addr(1) })), 200, "an address refunded pre-submit can still be served");
  } finally { await gw.close(); }
});

test("#1213-5: faucetAttempt caps /faucet attempts per IP per minute before the body is read", async () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  assert.equal(limits.faucetAttempt.limit, api.FAUCET_ATTEMPTS_PER_MINUTE);
  assert.equal(limits.faucetAttempt.windowMs, 60_000);
  const gw = await faucetWith(limits, async () => ({ txid: "t" }));
  try {
    for (let i = 0; i < api.FAUCET_ATTEMPTS_PER_MINUTE; i += 1) assert.equal(await gw.post("{bad"), 400);
    const reads = gw.state.reads;
    assert.equal(await gw.post(JSON.stringify({ address: addr(1) })), 429);
    assert.equal(gw.state.reads, reads, "refused before the body is read");
    assert.equal(limits.faucetIp.hits.size, 0, "attempts never touch the day quota");
  } finally { await gw.close(); }
});

// ---- #1213-6: reserved receivers and pre-submit marking -----------------------
test("#1213-6: the gateway's reserved receiver set matches the node's (mining tracker + both activity-window addresses)", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mining: any = await import(pathToFileURL(join(l1Root, "dist", "src", "mining.js")).href);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activity: any = await import(pathToFileURL(join(l1Root, "dist", "src", "activity.js")).href);
  const node = [mining.MINING_TRACKER_ADDRESS, activity.ACTIVITY_WINDOW_TIME_ADDRESS, activity.ACTIVITY_WINDOW_AMOUNT_ADDRESS];
  assert.deepEqual([...api.FAUCET_RESERVED_RECEIVERS].sort(), [...node].sort());
  for (const address of node) {
    assert.match(address, /^ZYN[0-9a-f]{40}$/, "reserved addresses pass the faucet's address shape check");
    assert.equal(api.FAUCET_RESERVED_RECEIVERS.has(address), true);
  }
  assert.equal(activity.isActivityWindowAddress(activity.ACTIVITY_WINDOW_TIME_ADDRESS), true);
  assert.equal(activity.isActivityWindowAddress(addr(3)), false, "ordinary addresses are not reserved");
});

test("#1213-6: a reserved receiver gets 400 before any quota is taken and never reaches send", async () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  // The send mock behaves like the node: it rejects reserved receivers.
  const gw = await faucetWith(limits, async () => { throw new Error("faucet transfer rejected by node (status 400): Mining tracker address is protocol-reserved"); });
  // The node's own constants, so this checks behaviour, not the mirror.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mining: any = await import(pathToFileURL(join(l1Root, "dist", "src", "mining.js")).href);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activity: any = await import(pathToFileURL(join(l1Root, "dist", "src", "activity.js")).href);
  try {
    for (const address of [mining.MINING_TRACKER_ADDRESS, activity.ACTIVITY_WINDOW_TIME_ADDRESS, activity.ACTIVITY_WINDOW_AMOUNT_ADDRESS]) assert.equal(await gw.post(JSON.stringify({ address })), 400, address);
    assert.equal(gw.state.sends, 0, "no node submission");
    assert.equal(limits.faucetIp.hits.size, 0);
    assert.equal(limits.faucetAddress.hits.size, 0);
    assert.equal(limits.faucetGlobal.hits.size, 0);
  } finally { await gw.close(); }
});

test("#1213-6: createFaucetSend marks only failures before POST /tx as preSubmit", async () => {
  const faucet = { address: `ZYN${"f".repeat(40)}`, privateKey: "k", publicKey: "p" };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const make = (over: any = {}) => {
    const calls: string[] = [];
    const anyNode = over.anyNode ?? (async (path: string) => {
      calls.push(path);
      if (path === "/status") return { status: 200, body: {} };
      if (path.startsWith("/nonce/")) return { status: 200, body: { nonce: 0 } };
      if (path === "/tx") return over.tx ? over.tx() : { status: 200, body: {} };
      return { status: 404, body: {} };
    });
    const send = api.createFaucetSend({
      chainStatus: over.chainStatus ?? (async () => ({ transactionVersion: 2 })), anyNode, chainId: "zyron-test", faucet,
      buildTransfer: (tx: { nonce: number }) => ({ ...tx, txid: `tx${tx.nonce}` }),
      transferFeeAtoms: over.transferFeeAtoms ?? (() => 1_000)
    });
    return { send, calls };
  };
  const failure = async (send: (r: string) => Promise<unknown>) => { try { await send(addr(5)); } catch (error) { return error as { preSubmit?: boolean; message: string }; } assert.fail("expected a failure"); };
  // Before POST /tx: chain status, fee floor, nonce lookup.
  const e1 = await failure(make({ chainStatus: async () => { throw new Error("status down"); } }).send);
  assert.equal(e1.preSubmit, true);
  const floor = make({ transferFeeAtoms: () => { throw new (class extends Error { code = "fee-floor"; })("fee floor"); } });
  const e2 = await failure(floor.send);
  assert.equal(e2.preSubmit, true);
  assert.equal(floor.calls.includes("/tx"), false);
  const nonce = make({ anyNode: async (path: string) => path === "/status" ? { status: 200, body: {} } : { status: 502, body: {} } });
  const e3 = await failure(nonce.send);
  assert.equal(e3.preSubmit, true);
  assert.match(e3.message, /nonce lookup failed/);
  // POST /tx sent: node rejection, 5xx and timeout are never preSubmit.
  for (const tx of [() => ({ status: 400, body: { error: "Mining tracker address is protocol-reserved" } }), () => ({ status: 503, body: {} }), () => { throw new Error("The operation was aborted due to timeout"); }]) {
    const m = make({ tx });
    const e = await failure(m.send);
    assert.notEqual(e.preSubmit, true, e.message);
    assert.equal(m.calls.includes("/tx"), true);
  }
  const ok = make();
  assert.deepEqual(await ok.send(addr(5)), { txid: "tx1", receiver: addr(5), amountAtoms: 100 * 100_000_000, nonce: 1 });
});

// ---- #1213-7: a refund is bound to the window entry it took from -------------
test("#1213-7: a refund after the window rolled over credits nothing in the new window", () => {
  const l = new api.WindowLimiter(1, 1_000, 10, { evictOnFull: true, prefixCap: 2 });
  const old = l.takeWithReceipt(v6(1, 0), 900);
  assert.equal(old.allowed, true);
  assert.equal(l.take(v6(1, 0), 1_000).allowed, false, "same window: limited");
  assert.equal(l.take(v6(1, 0), 1_900).allowed, true, "new window for the same key");
  assert.equal(l.refund(old.receipt, 1_901), false, "stale receipt");
  assert.equal(l.hits.get(v6(1, 0)).count, 1);
  assert.equal(l.take(v6(1, 0), 1_902).allowed, false, "still limited in the new window");
  assert.equal(l.prefixBudget.get("2001:0db8:0001::/48").count, 1, "the new window's /48 budget is untouched");
  // Same for the single-key faucetGlobal table across its hour.
  const g = api.createGatewayLimits({ env: {}, log: () => {} }).faucetGlobal;
  const stale = g.takeWithReceipt("global", 0);
  for (let i = 0; i < 200; i += 1) assert.equal(g.take("global", 3_600_000 + i).allowed, true);
  assert.equal(g.refund(stale.receipt, 3_600_500), false);
  assert.equal(g.take("global", 3_600_600).allowed, false, "no extra drip after a stale refund");
  // Within the same window the receipt still works.
  const fresh = g.takeWithReceipt("global", 7_200_000);
  assert.equal(g.refund(fresh.receipt, 7_200_001), true);
  assert.equal(g.hits.size, 0);
});
