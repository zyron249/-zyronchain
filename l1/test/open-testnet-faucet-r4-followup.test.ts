// Follow-up to #1213 (Red Team R4-1/R4-4/R4-5, Security r3 R3-1/R3-2/R3-3):
// - R4-1: a 20-drip daily faucet budget per IPv6 /48 and per IPv4 /24
//   (faucetPrefix), peeked and taken with the other faucet tables, in front of
//   faucetGlobal, with a Retry-After and a deniedLimit counter in /health;
// - R4-4: /faucet bodies above 512 bytes get 413 before they are parsed;
// - R4-5: the route-level test drives the real createFaucetRoute with the
//   real createGatewayLimits tables;
// - R3-1: refund(receipt) is single-use;
// - R3-2: the genesis activity pool is a reserved receiver (400);
// - R3-3: markFaucetPreSubmit returns a new Error with the original as cause.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const identity: any = await import(pathToFileURL(join(l1Root, "dist", "src", "rpc-client-identity.js")).href);
const bucket = (address: string): string => identity.clientAddressBucket(address);
const ALLOWED = new Set<string>(api.DEFAULT_FAUCET_ALLOWED_ORIGINS);
const FAUCET = `ZYN${"f".repeat(40)}`;
// Leading "a" keeps test addresses clear of the reserved ZYN000…0/1/2 range.
const addr = (n: number) => `ZYNa${n.toString(16).padStart(39, "0")}`;
const DAY_S = 86_400;

// The real /faucet handler over HTTP. The body reader here ignores any size
// cap on purpose, so the R4-4 checks prove the route itself enforces it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function faucet(limits: any, { send = async () => ({ txid: "t" }), reservedReceivers }: { send?: () => Promise<unknown>; reservedReceivers?: string[] } = {}) {
  const state = { reads: 0, sends: 0, ip: bucket("198.51.100.1") };
  async function readJsonBody(request: IncomingMessage) {
    state.reads += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
  }
  const route = api.createFaucetRoute({ origins: ALLOWED, limits, faucetAddress: FAUCET, readJsonBody, send: async () => { state.sends += 1; return send(); }, log: () => {}, ...(reservedReceivers ? { reservedReceivers } : {}) });
  const server: Server = createServer((request, response) => { void route(request, response, state.ip); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (ip: string, body: string) => {
    state.ip = ip;
    const r = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const text = await r.text();
    return { status: r.status, retryAfter: r.headers.get("retry-after"), body: text ? JSON.parse(text) : undefined };
  };
  return { state, post, close: () => new Promise((done) => server.close(done)) };
}
const drip = (n: number) => JSON.stringify({ address: addr(n) });

test("R4-5 route: 20 drips per IPv4 /24 and per IPv6 /48 per day, then 429 with Retry-After, nothing else spent, counted in /health; a 600-byte body gets 413", async () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  const gw = await faucet(limits);
  try {
    // Twenty different IPv4 addresses in 198.51.100.0/24, fresh receivers each.
    for (let i = 0; i < 20; i += 1) assert.equal((await gw.post(bucket(`198.51.100.${10 + i}`), drip(i))).status, 200, `IPv4 drip ${i}`);
    const ip21 = bucket("198.51.100.200");
    const denied = await gw.post(ip21, drip(100));
    assert.equal(denied.status, 429, "21st drip from the /24");
    const retry = Number(denied.retryAfter);
    assert.ok(retry > DAY_S - 120 && retry <= DAY_S, `Retry-After ${retry}`);
    assert.equal(gw.state.sends, 20);
    assert.equal(limits.faucetIp.hits.has(ip21), false, "the refused IP spent no faucetIp quota");
    assert.equal(limits.faucetAddress.hits.has(addr(100)), false, "the refused receiver spent no faucetAddress quota");
    assert.equal(limits.faucetGlobal.hits.get("global").count, 20, "faucetGlobal is not spent by the refusal");
    // A spent prefix is refused before its body is read.
    const reads = gw.state.reads;
    assert.equal((await gw.post(bucket("198.51.100.201"), "{bad")).status, 429);
    assert.equal(gw.state.reads, reads, "refused before the body is read");
    // Another /24 is unaffected.
    assert.equal((await gw.post(bucket("198.51.101.7"), drip(101))).status, 200, "another /24");
    // Twenty /64s in one IPv6 /48, then the 21st /64 is refused.
    for (let i = 0; i < 20; i += 1) assert.equal((await gw.post(bucket(`2001:db8:99:${(i + 1).toString(16)}::1`), drip(200 + i))).status, 200, `IPv6 drip ${i}`);
    assert.equal((await gw.post(bucket("2001:db8:99:ff::1"), drip(300))).status, 429, "21st /64 from the /48");
    assert.equal((await gw.post(bucket("2001:db8:9a:1::1"), drip(301))).status, 200, "another /48");
    const health = api.rateLimitersHealth(limits).faucetPrefix;
    assert.equal(health.deniedLimit, 3, "every prefix refusal is counted once");
    assert.equal(health.size, 4, "four prefixes tracked");
    assert.equal(health.fill, "ok");
    assert.equal(JSON.stringify(health).includes("198."), false, "/health carries counts, never prefixes");
    // R4-4: a valid but padded body above 512 bytes is refused with 413 and spends nothing.
    const fresh = bucket("203.0.113.5");
    const big = JSON.stringify({ address: addr(400), pad: "x".repeat(600) });
    assert.ok(Buffer.byteLength(big) > 512);
    const sends = gw.state.sends;
    const tooLarge = await gw.post(fresh, big);
    assert.equal(tooLarge.status, 413);
    assert.equal(tooLarge.body.error, "request body too large");
    assert.equal(gw.state.sends, sends);
    assert.equal(limits.faucetIp.hits.has(fresh), false, "413 spends no day quota");
    assert.equal(limits.faucetPrefix.hits.has("203.0.113.0/24"), false);
    // A padded body just under the cap is still served.
    const small = JSON.stringify({ address: addr(401), pad: "x".repeat(400) });
    assert.ok(Buffer.byteLength(small) <= 512);
    assert.equal((await gw.post(fresh, small)).status, 200);
  } finally { await gw.close(); }
});

test("R4-1 route: a pre-submit failure refunds the prefix budget too; a node rejection does not", async () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  let mode = "pre";
  const gw = await faucet(limits, { send: async () => {
    if (mode === "pre") throw api.markFaucetPreSubmit(new Error("faucet nonce lookup failed (status 502)"));
    if (mode === "rejected") throw new Error("faucet transfer rejected by node (status 400): nope");
    return { txid: "t" };
  } });
  try {
    for (let i = 0; i < 25; i += 1) assert.equal((await gw.post(bucket(`192.0.2.${i + 1}`), drip(i))).status, 503);
    assert.equal(limits.faucetPrefix.hits.has("192.0.2.0/24"), false, "25 pre-submit failures spend none of the /24's 20 drips");
    mode = "rejected";
    assert.equal((await gw.post(bucket("192.0.2.100"), drip(50))).status, 503);
    assert.equal(limits.faucetPrefix.hits.get("192.0.2.0/24").count, 1, "a node rejection is not refunded");
  } finally { await gw.close(); }
});

test("R4-1: faucetPrefix wiring, prefix keys and deniedLimit counting", () => {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  const t = limits.faucetPrefix;
  assert.equal(api.FAUCET_PREFIX_DRIPS_PER_DAY, 20);
  assert.equal(t.limit, 20);
  assert.equal(t.windowMs, 86_400_000);
  assert.equal(t.maxKeys, api.DAY_WINDOW_LIMITER_MAX_KEYS);
  assert.equal(t.evictOnFull, false, "deny-on-full: eviction would reset a prefix's day budget");
  assert.equal(t.prefixCap, 0);
  assert.equal(t.countLimited, true);
  assert.deepEqual(Object.keys(api.rateLimitersHealth(limits)).sort(), ["faucetAddress", "faucetAttempt", "faucetGlobal", "faucetIp", "faucetPrefix", "read", "relayIp", "snapshot", "write"]);
  // Only faucetPrefix reports deniedLimit, so other tables keep their /health shape.
  for (const name of ["read", "write", "relayIp", "faucetIp", "faucetAddress", "faucetAttempt", "faucetGlobal", "snapshot"]) assert.equal("deniedLimit" in limits[name].stats(), false, name);
  assert.equal(api.faucetPrefixKey(bucket("198.51.100.77")), "198.51.100.0/24");
  assert.equal(api.faucetPrefixKey(bucket("::ffff:198.51.100.77")), "198.51.100.0/24", "IPv4-mapped IPv6 is bucketed as IPv4");
  assert.equal(api.faucetPrefixKey(bucket("2001:db8:99:1234::1")), "2001:0db8:0099::/48");
  assert.equal(api.faucetPrefixKey(bucket("2001:db8:99:ffff::1")), api.faucetPrefixKey(bucket("2001:db8:99::2")), "every /64 in a /48 shares one budget");
  for (const key of ["unknown", "proxy:198.51.100.7", "999.1.1.1", "", undefined]) assert.equal(api.faucetPrefixKey(key), undefined, String(key));
  // peek(record) and take both count a limit refusal; peek predicts take.
  const l = new api.WindowLimiter(2, 1_000, 10, { countLimited: true });
  assert.equal(l.take("p", 0).allowed, true);
  assert.equal(l.take("p", 1).allowed, true);
  assert.deepEqual(l.peek("p", 10), { allowed: false, retryAfterMs: 990 });
  assert.equal(l.stats().deniedLimit, 0, "a plain peek counts nothing");
  assert.deepEqual(l.peek("p", 10, { record: true }), { allowed: false, retryAfterMs: 990 });
  assert.deepEqual(l.take("p", 10), { allowed: false, retryAfterMs: 990 });
  assert.equal(l.stats().deniedLimit, 2);
  assert.equal(l.take("p", 1_000).allowed, true, "new window");
});

test("R4-4: readJsonRequestBody refuses a body above its cap before parsing, also without a Content-Length", async () => {
  assert.equal(api.FAUCET_MAX_BODY_BYTES, 512);
  const results: unknown[] = [];
  const server: Server = createServer(async (request, response) => {
    try { results.push(await api.readJsonRequestBody(request, api.FAUCET_MAX_BODY_BYTES)); } catch (error) { results.push({ statusCode: (error as { statusCode?: number }).statusCode, message: (error as Error).message }); }
    response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  // Chunked (no Content-Length): the streamed size is checked.
  const chunked = (chunks: string[]) => new Promise<void>((done, fail) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/faucet", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } }, (res) => { res.resume(); res.on("end", () => done()); });
    req.on("error", fail);
    for (const c of chunks) req.write(c);
    req.end();
  });
  try {
    await chunked([`{"address":"${addr(1)}",`, `"pad":"${"[".repeat(600)}"}`]);
    assert.deepEqual(results.pop(), { statusCode: 413, message: "request body too large" });
    await chunked([JSON.stringify({ address: addr(2) })]);
    assert.deepEqual(results.pop(), { address: addr(2) });
    // The default cap is still the 8 KB /tx limit.
    const big = await new Promise<unknown>((done) => {
      const s2: Server = createServer(async (request, response) => { try { done(await api.readJsonRequestBody(request)); } catch (e) { done(e); } response.end(); s2.close(); });
      s2.listen(0, "127.0.0.1", async () => { const p = (s2.address() as { port: number }).port; const x = await fetch(`http://127.0.0.1:${p}/`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(4_000) }) }); await x.arrayBuffer(); });
    });
    assert.equal((big as { pad: string }).pad.length, 4_000, "a 4 KB /tx body is still accepted by default");
  } finally { await new Promise((done) => server.close(done)); }
});

test("R3-1: refund(receipt) is single-use; a reused receipt returns false and changes nothing", () => {
  const l = new api.WindowLimiter(5, 60_000, 10);
  const first = l.takeWithReceipt("k", 0);
  l.take("k", 1);
  l.take("k", 2);
  assert.equal(l.hits.get("k").count, 3);
  assert.equal(l.refund(first.receipt, 3), true);
  assert.equal(l.refund(first.receipt, 4), false, "second refund of the same receipt");
  assert.equal(l.refund(first.receipt, 5), false, "third refund of the same receipt");
  assert.equal(l.hits.get("k").count, 2, "count went 3 -> 2, not 3 -> 0");
  // Same on an evicting table with a /48 budget: the budget is credited once.
  const e = new api.WindowLimiter(5, 60_000, 10, { evictOnFull: true, prefixCap: 2 });
  const key = "ipv6:2001:0db8:0001:0000/64";
  const r = e.takeWithReceipt(key, 0);
  e.take(key, 1);
  assert.equal(e.refund(r.receipt, 2), true);
  assert.equal(e.refund(r.receipt, 3), false);
  assert.equal(e.prefixBudget.get("2001:0db8:0001::/48").count, 1);
  assert.equal(e.hits.get(key).count, 1);
});

test("R3-3: markFaucetPreSubmit returns a new Error carrying preSubmit, with the original as its cause", async () => {
  const original = new Error("faucet nonce lookup failed (status 502)");
  const marked = api.markFaucetPreSubmit(original);
  assert.notEqual(marked, original, "the caught error object is not flagged");
  assert.equal(marked instanceof Error, true);
  assert.equal(marked.preSubmit, true);
  assert.equal(marked.cause, original);
  assert.equal(marked.message, original.message);
  assert.equal((original as { preSubmit?: boolean }).preSubmit, undefined, "the original stays unflagged");
  const fromString = api.markFaucetPreSubmit("boom");
  assert.equal(fromString.message, "boom");
  assert.equal(fromString.cause, "boom");
  // A fee-floor failure from the real createFaucetSend still reaches the caller as 503 fee-floor.
  const send = api.createFaucetSend({
    chainStatus: async () => ({ transactionVersion: 2 }), chainId: "zyron-test", faucet: { address: FAUCET, privateKey: "k", publicKey: "p" },
    anyNode: async (path: string) => path === "/status" ? { status: 200, body: { minTransferFeeAtoms: api.MAX_FAUCET_FEE_ATOMS + 1, fixedTransferFeeAtoms: null } } : { status: 200, body: { nonce: 0 } },
    buildTransfer: (tx: { nonce: number }) => ({ ...tx, txid: `tx${tx.nonce}` })
  });
  const caught = await send(addr(1)).then(() => assert.fail("expected a fee-floor failure"), (error: unknown) => error as { preSubmit?: boolean; cause?: unknown });
  assert.equal(caught.preSubmit, true);
  assert.equal(caught.cause instanceof api.FaucetFeeFloorError, true);
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  const gw = await faucet(limits, { send: () => send(addr(2)) });
  try {
    const r = await gw.post(bucket("198.51.100.9"), drip(2));
    assert.equal(r.status, 503);
    assert.equal(r.body.code, "fee-floor");
    assert.match(r.body.error, /MAX_FAUCET_FEE_ATOMS/);
    assert.equal(limits.faucetIp.hits.size, 0, "a pre-submit fee-floor failure is refunded");
    assert.equal(limits.faucetPrefix.hits.size, 0);
  } finally { await gw.close(); }
});

test("R3-2: the genesis activity pool is a reserved receiver: 400 before any quota is taken, never sent", async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state: any = await import(pathToFileURL(join(l1Root, "dist", "src", "state.js")).href);
  const pool = `ZYN${"e".repeat(40)}`;
  assert.throws(() => state.assertNoActivityPoolInflow(pool, pool), /Activity pool cannot receive funds/, "the node rejects inflow to the pool");
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  const gw = await faucet(limits, { reservedReceivers: [pool] });
  try {
    const r = await gw.post(bucket("198.51.100.7"), JSON.stringify({ address: pool }));
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "address is protocol-reserved");
    assert.equal(gw.state.sends, 0);
    for (const name of ["faucetIp", "faucetAddress", "faucetPrefix", "faucetGlobal"]) assert.equal(limits[name].hits.size, 0, name);
    assert.equal((await gw.post(bucket("198.51.100.7"), drip(1))).status, 200, "ordinary receivers are still served");
  } finally { await gw.close(); }
  // The gateway derives the list from its genesis (runNetwork passes it to createFaucetRoute).
  assert.deepEqual(api.faucetGenesisReservedReceivers({ activityPool: pool }), [pool]);
  assert.deepEqual(api.faucetGenesisReservedReceivers({}), []);
  assert.deepEqual(api.faucetGenesisReservedReceivers({ activityPool: "not-an-address" }), []);
});
