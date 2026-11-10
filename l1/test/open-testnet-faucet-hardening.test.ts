// Faucet hardening follow-up to #1218 (Red Team F1, Security N1/N2/N4/N5):
// - F1: the gateway server checks its request timeouts every 1 s, and a
//   /faucet body must fully arrive within 2 s (408), so dripped bodies free
//   their request slot; /tx keeps Node's 10 s requestTimeout;
// - N1: keys with no IP identity share an other:<key> faucetPrefix budget;
// - N2: 6to4, NAT64 and IPv4-compatible/mapped addresses use their embedded
//   IPv4 /24 as the faucet prefix;
// - N4: after a 413 (/faucet and /tx) the reply says Connection: close and the
//   gateway stops reading the body;
// - N5: the 413 limits (declared and received bytes) through runNetwork.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { allocateValidatorBasePort } from "./helpers/open-testnet-ports.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const identity: any = await import(pathToFileURL(join(l1Root, "dist", "src", "rpc-client-identity.js")).href);
const bucket = (address: string): string => identity.clientAddressBucket(address);
const ALLOWED = new Set<string>(api.DEFAULT_FAUCET_ALLOWED_ORIGINS);
const FAUCET = `ZYN${"f".repeat(40)}`;
const addr = (n: number) => `ZYNa${n.toString(16).padStart(39, "0")}`;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface RawResult { status: number | undefined; head: string; ms: number; closedMs: number | undefined; sent: number }
// One raw HTTP/1.1 request. `drip`: send the body one byte every gapMs.
// `flood`: after the head, keep writing 64 KiB chunks (Content-Length or
// chunked framing) until the server closes or waitMs passes.
function raw(port: number, { path = "/faucet", headers = {} as Record<string, string>, body = "", gapMs = 0, flood = false, chunked = false, waitMs = 5_000 } = {}): Promise<RawResult> {
  return new Promise((done) => {
    const t0 = Date.now();
    const s = net.connect(port, "127.0.0.1");
    let got = ""; let status: number | undefined; let ms = 0; let closedMs: number | undefined; let sent = 0; let finished = false;
    const finish = () => { if (finished) return; finished = true; clearTimeout(timer); s.destroy(); done({ status, head: got.split("\r\n\r\n")[0] ?? "", ms, closedMs, sent }); };
    const timer = setTimeout(finish, waitMs);
    // Plain requests finish once the whole response is in; flood and drip
    // requests wait for the server to close (that is what they measure).
    const untilClose = flood || gapMs > 0;
    s.on("data", (d) => {
      got += d;
      const m = /^HTTP\/1\.1 (\d{3})/.exec(got);
      if (m && status === undefined) { status = Number(m[1]); ms = Date.now() - t0; }
      const end = got.indexOf("\r\n\r\n");
      const length = /\r\ncontent-length: (\d+)/i.exec(got);
      if (!untilClose && end >= 0 && length && Buffer.byteLength(got) - end - 4 >= Number(length[1])) finish();
    });
    s.on("close", () => { closedMs = Date.now() - t0; finish(); });
    s.on("error", () => {});
    const framing = chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(flood ? 100_000_000 : Buffer.byteLength(body)) };
    const head = Object.entries({ host: "gateway", "content-type": "application/json", ...framing, ...headers }).map(([k, v]) => `${k}: ${v}`).join("\r\n");
    s.write(`POST ${path} HTTP/1.1\r\n${head}\r\n\r\n`);
    if (flood) {
      const chunk = Buffer.alloc(64 * 1024, 0x20);
      const framed = chunked ? Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")]) : chunk;
      const pump = () => { while (!finished && !s.destroyed && sent < 200_000_000) { sent += framed.length; if (!s.write(framed)) { s.once("drain", pump); return; } } };
      pump();
      return;
    }
    if (gapMs > 0) {
      let i = 0;
      const tick = () => { if (finished || s.destroyed || i >= body.length) { if (chunked && !finished && !s.destroyed) s.write("0\r\n\r\n"); return; } const b = body[i++]!; s.write(chunked ? `1\r\n${b}\r\n` : b); sent += 1; setTimeout(tick, gapMs); };
      tick();
    } else {
      s.write(chunked ? `${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n` : body);
      sent = Buffer.byteLength(body);
    }
  });
}

// The real gateway server (createGatewayServer) around the real /faucet route
// and body reader, with the gateway's 64-slot accounting, plus a /tx-style
// path that reads with the default reader (no body deadline).
async function gatewayWithFaucet() {
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  const state = { active: 0, sends: 0, sockets: [] as net.Socket[] };
  const route = api.createFaucetRoute({ origins: ALLOWED, limits, faucetAddress: FAUCET, readJsonBody: (r: IncomingMessage, max: number, opts: unknown) => api.readJsonRequestBody(r, max, opts), send: async () => { state.sends += 1; return { txid: "t" }; }, log: () => {} });
  const server: Server = api.createGatewayServer((request: IncomingMessage, response: ServerResponse) => {
    state.active += 1; response.once("close", () => { state.active -= 1; });
    const ip = bucket(String(request.headers["x-test-ip"] ?? "198.51.100.1"));
    if (request.url === "/tx") {
      api.readJsonRequestBody(request).then(() => { response.writeHead(200); response.end("{}"); }, (error: { statusCode?: number }) => { response.writeHead(error.statusCode ?? 500); response.end(); });
      return;
    }
    void route(request, response, ip);
  });
  server.on("connection", (socket: net.Socket) => state.sockets.push(socket));
  const port = await api.listenGateway(server, 0, "127.0.0.1");
  return { limits, state, port, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }) };
}
const BODY = JSON.stringify({ address: addr(1) });

test("F1: a slow-drip /faucet body gets 408 within about 3 s and frees its slot; normal clients and /tx are unaffected", { timeout: 60_000 }, async () => {
  const gw = await gatewayWithFaucet();
  try {
    // Ten slow bodies at once (1 byte every 250 ms would take ~14 s each).
    const drips = await Promise.all(Array.from({ length: 10 }, (_, i) => raw(gw.port, { body: JSON.stringify({ address: addr(10 + i) }), gapMs: 250, headers: { "x-test-ip": `198.51.100.${20 + i}` }, waitMs: 6_000 })));
    for (const [i, r] of drips.entries()) {
      assert.equal(r.status, 408, `drip ${i}: status ${r.status} after ${r.ms} ms`);
      assert.ok(r.ms >= 1_900 && r.ms <= 3_000, `drip ${i}: 408 after ${r.ms} ms`);
      assert.match(r.head, /connection: close/i);
      assert.ok(r.closedMs !== undefined && r.closedMs <= 3_500, `drip ${i}: socket closed at ${r.closedMs} ms`);
      assert.ok(r.sent < 15, `drip ${i}: stopped after ${r.sent} bytes`);
    }
    await sleep(100);
    assert.equal(gw.state.active, 0, "every slot is freed");
    assert.equal(gw.state.sends, 0);
    assert.equal(gw.limits.faucetIp.hits.size, 0, "a 408 spends no day quota");
    // A normal client, and a chunked one, are served.
    assert.equal((await raw(gw.port, { body: BODY, headers: { "x-test-ip": "198.51.100.60" } })).status, 200);
    assert.equal((await raw(gw.port, { body: JSON.stringify({ address: addr(2) }), chunked: true, headers: { "x-test-ip": "198.51.100.61" } })).status, 200);
    // /tx has no 2 s body deadline: a 3.4 s body is still read.
    const tx = await raw(gw.port, { path: "/tx", body: BODY, gapMs: 60, waitMs: 8_000 });
    assert.equal(tx.status, 200, `/tx slow body: ${tx.status} after ${tx.ms} ms`);
    assert.ok(tx.ms > 3_000);
    assert.equal(api.FAUCET_BODY_DEADLINE_MS, 2_000);
    assert.equal(api.GATEWAY_CONNECTIONS_CHECKING_INTERVAL_MS, 1_000);
  } finally { await gw.close(); }
});

test("F1: Node's 10 s requestTimeout is enforced within about 1 s (connectionsCheckingInterval 1 s), on /tx too", { timeout: 60_000 }, async () => {
  const gw = await gatewayWithFaucet();
  try {
    const r = await raw(gw.port, { path: "/tx", body: `${BODY}${" ".repeat(40)}`, gapMs: 1_000, waitMs: 14_000 });
    assert.equal(r.status, 408, `status ${r.status} after ${r.ms} ms (the old 30 s check let this run ~40 s)`);
    assert.ok(r.ms >= 9_500 && r.ms <= 12_000, `408 after ${r.ms} ms`);
    await sleep(100);
    assert.equal(gw.state.active, 0);
  } finally { await gw.close(); }
});

test("N4: after a 413 on /faucet the reply says Connection: close and the gateway stops reading (declared length and chunked)", { timeout: 60_000 }, async () => {
  const gw = await gatewayWithFaucet();
  try {
    for (const chunked of [false, true]) {
      const before = gw.state.sockets.length;
      const r = await raw(gw.port, { flood: true, chunked, headers: { "x-test-ip": chunked ? "198.51.100.71" : "198.51.100.70" }, waitMs: 4_000 });
      assert.equal(r.status, 413, `chunked=${chunked}`);
      assert.match(r.head, /connection: close/i);
      assert.ok(r.closedMs !== undefined && r.closedMs < 2_000, `chunked=${chunked}: socket closed at ${r.closedMs} ms`);
      const socket = gw.state.sockets[before]!;
      assert.ok(socket.bytesRead < 4 * 1024 * 1024, `chunked=${chunked}: the server read ${socket.bytesRead} bytes (it used to drain the whole body)`);
    }
    await sleep(100);
    assert.equal(gw.state.active, 0);
    assert.equal(gw.state.sends, 0);
  } finally { await gw.close(); }
});

test("N1: requests with no IP identity share an other:<key> faucetPrefix budget", async () => {
  for (const key of ["unknown", "proxy:198.51.100.7", "proxy:ipv6:2001:0db8:0000:0001/64"]) assert.equal(api.faucetPrefixKey(key), `other:${key}`);
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  // Through the real route (in-process response stub not needed: use the gateway server).
  const route = api.createFaucetRoute({ origins: ALLOWED, limits, faucetAddress: FAUCET, readJsonBody: (r: IncomingMessage, m: number, o: unknown) => api.readJsonRequestBody(r, m, o), send: async () => ({ txid: "t" }), log: () => {} });
  const server: Server = api.createGatewayServer((request: IncomingMessage, response: ServerResponse) => { void route(request, response, String(request.headers["x-key"])); });
  const port = await api.listenGateway(server, 0, "127.0.0.1");
  try {
    for (let i = 0; i < 5; i += 1) assert.equal((await raw(port, { body: JSON.stringify({ address: addr(100 + i) }), headers: { "x-key": "unknown" } })).status, 200);
    assert.equal(limits.faucetPrefix.hits.get("other:unknown").count, 5, "the shared 'unknown' bucket spends one prefix budget");
    for (let i = 0; i < 3; i += 1) assert.equal((await raw(port, { body: JSON.stringify({ address: addr(200 + i) }), headers: { "x-key": "proxy:198.51.100.7" } })).status, 200);
    assert.equal(limits.faucetPrefix.hits.get("other:proxy:198.51.100.7").count, 3);
    // A spent other: budget refuses with 429 like any prefix.
    for (let i = 0; i < 20; i += 1) limits.faucetPrefix.take("other:proxy:203.0.113.9");
    assert.equal((await raw(port, { body: JSON.stringify({ address: addr(300) }), headers: { "x-key": "proxy:203.0.113.9" } })).status, 429);
    assert.equal(limits.faucetIp.hits.has("proxy:203.0.113.9"), false);
  } finally { await new Promise((done) => { server.closeAllConnections?.(); server.close(done); }); }
});

test("N2: 6to4, NAT64 and IPv4-compatible/mapped addresses use their embedded IPv4 /24 as the faucet prefix", async () => {
  const k = (literal: string) => api.faucetPrefixKey(bucket(literal), literal);
  // 6to4 2002:AABB:CCDD::/48 embeds AA.BB.CC.DD (198.51.100.1 = c633:6401); the key alone suffices.
  assert.equal(api.faucetPrefixKey(bucket("2002:c633:6401::1")), "198.51.100.0/24");
  assert.equal(k("2002:c633:64ff:1234::9"), "198.51.100.0/24", "every 6to4 /48 of one IPv4 /24 shares its budget");
  // NAT64 well-known prefix 64:ff9b::/96 (dotted and hex spellings).
  assert.equal(k("64:ff9b::198.51.100.7"), "198.51.100.0/24");
  assert.equal(k("64:FF9B::c633:6450"), "198.51.100.0/24");
  assert.equal(k("64:ff9b::203.0.113.1"), "203.0.113.0/24", "different embedded /24s are different prefixes");
  assert.equal(api.faucetPrefixKey(bucket("64:ff9b::198.51.100.7")), "0064:ff9b:0000::/48", "without the literal, the /48");
  // IPv4-compatible ::a.b.c.d.
  assert.equal(k("::198.51.100.7"), "198.51.100.0/24");
  // IPv4-mapped (dotted, hex, expanded) is bucketed as IPv4 already.
  for (const literal of ["::ffff:198.51.100.7", "::ffff:c633:6407", "0:0:0:0:0:ffff:198.51.100.7"]) assert.equal(k(literal), "198.51.100.0/24", literal);
  // Not embedded: native IPv6, ::1, and a literal that is not the key's own address.
  assert.equal(k("2001:db8:1:2::3"), "2001:0db8:0001::/48");
  assert.equal(k("::1"), "0000:0000:0000::/48");
  assert.equal(api.faucetPrefixKey(bucket("2001:db8:1:2::3"), "64:ff9b::198.51.100.7"), "2001:0db8:0001::/48", "a literal from another /64 cannot pick the prefix");
  // The literal the gateway identity used.
  const lit = api.gatewayClientAddressLiteral;
  assert.equal(lit("64:ff9b::c633:6407", {}, { trustCloudflareConnectingIp: false }), "64:ff9b::c633:6407");
  assert.equal(lit("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 64:ff9b::198.51.100.7" }, { trustCloudflareConnectingIp: false }), " 64:ff9b::198.51.100.7");
  assert.equal(lit("10.0.0.1", { "cf-connecting-ip": "64:ff9b::198.51.100.7" }, { trustCloudflareConnectingIp: true }), "64:ff9b::198.51.100.7");
  assert.equal(lit("10.0.0.1", { "x-forwarded-for": "64:ff9b::1" }, { trustCloudflareConnectingIp: false }), "10.0.0.1", "forwarding headers are ignored from a non-loopback peer");
  // Through the real route: 20 different 6to4 /48s plus one IPv4 address share 198.51.100.0/24.
  const limits = api.createGatewayLimits({ env: {}, log: () => {} });
  const route = api.createFaucetRoute({ origins: ALLOWED, limits, faucetAddress: FAUCET, readJsonBody: (r: IncomingMessage, m: number, o: unknown) => api.readJsonRequestBody(r, m, o), send: async () => ({ txid: "t" }), log: () => {} });
  const server: Server = api.createGatewayServer((request: IncomingMessage, response: ServerResponse) => { const literal = String(request.headers["x-literal"]); void route(request, response, bucket(literal), literal); });
  const port = await api.listenGateway(server, 0, "127.0.0.1");
  try {
    for (let i = 0; i < 18; i += 1) assert.equal((await raw(port, { body: JSON.stringify({ address: addr(400 + i) }), headers: { "x-literal": `2002:c633:64${(i + 16).toString(16)}::1` } })).status, 200, `6to4 ${i}`);
    assert.equal((await raw(port, { body: JSON.stringify({ address: addr(450) }), headers: { "x-literal": "64:ff9b::198.51.100.200" } })).status, 200, "NAT64");
    assert.equal((await raw(port, { body: JSON.stringify({ address: addr(451) }), headers: { "x-literal": "198.51.100.201" } })).status, 200, "native IPv4");
    const denied = await raw(port, { body: JSON.stringify({ address: addr(452) }), headers: { "x-literal": "2002:c633:64aa::1" } });
    assert.equal(denied.status, 429, "the 21st drip from 198.51.100.0/24, whatever the encoding");
    assert.equal(limits.faucetPrefix.hits.get("198.51.100.0/24").count, 20);
  } finally { await new Promise((done) => { server.closeAllConnections?.(); server.close(done); }); }
});

test("N5 + N4 through runNetwork: /faucet and /tx 413 on declared and received (chunked) bytes, close the connection, and a dripped /faucet body gets 408", { timeout: 900_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-faucet-hardening-"));
  await chmod(root, 0o700);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let network: any;
  try {
    await api.initNetwork(join(root, "n"), "zyron-faucet-hardening-testnet-1");
    network = await api.runNetwork(join(root, "n"), { gatewayPort: 0, basePort: await allocateValidatorBasePort("faucet-hardening"), log: false });
    const port: number = network.port;
    // Loopback peer + X-Forwarded-For: each case gets its own client identity.
    const xff = (n: number) => ({ "x-forwarded-for": `198.51.${100 + n}.9` });
    // /faucet, declared length above 512 B: 413 before anything is read.
    const declared = await raw(port, { body: JSON.stringify({ address: addr(1), pad: "x".repeat(600) }), headers: xff(0) });
    assert.equal(declared.status, 413);
    assert.match(declared.head, /connection: close/i);
    // /faucet, chunked (no Content-Length): the received-bytes cap of the gateway's own reader.
    const chunked = await raw(port, { body: JSON.stringify({ address: addr(2), pad: "x".repeat(600) }), chunked: true, headers: xff(1) });
    assert.equal(chunked.status, 413, "chunked body above 512 B");
    assert.match(chunked.head, /connection: close/i);
    // A body under the cap still reaches validation (400 for a bad address, not 413).
    assert.equal((await raw(port, { body: JSON.stringify({ address: "nope", pad: "x".repeat(400) }), chunked: true, headers: xff(2) })).status, 400);
    // /faucet flood after 413: the connection closes, the client cannot keep pushing.
    const faucetFlood = await raw(port, { flood: true, chunked: true, headers: xff(3), waitMs: 4_000 });
    assert.equal(faucetFlood.status, 413);
    assert.ok(faucetFlood.closedMs !== undefined && faucetFlood.closedMs < 2_000, `/faucet flood closed at ${faucetFlood.closedMs}`);
    // /tx keeps its 8 KB cap: declared and chunked, and it closes too.
    const txDeclared = await raw(port, { path: "/tx", flood: true, headers: xff(4), waitMs: 4_000 });
    assert.equal(txDeclared.status, 413);
    assert.match(txDeclared.head, /connection: close/i);
    assert.ok(txDeclared.closedMs !== undefined && txDeclared.closedMs < 2_000, `/tx declared flood closed at ${txDeclared.closedMs}`);
    assert.ok(txDeclared.sent < 32 * 1024 * 1024, `/tx: client pushed ${txDeclared.sent} bytes`);
    const txChunked = await raw(port, { path: "/tx", flood: true, chunked: true, headers: xff(5), waitMs: 4_000 });
    assert.equal(txChunked.status, 413);
    assert.ok(txChunked.closedMs !== undefined && txChunked.closedMs < 2_000, `/tx chunked flood closed at ${txChunked.closedMs}`);
    // A small /tx body is still parsed (400 for a non-transfer), not refused.
    assert.equal((await raw(port, { path: "/tx", body: JSON.stringify({ kind: "nope" }), headers: xff(6) })).status, 400);
    // F1 through the real gateway: a dripped /faucet body gets 408 within about 3 s.
    const drip = await raw(port, { body: JSON.stringify({ address: addr(3) }), gapMs: 250, headers: xff(7), waitMs: 6_000 });
    assert.equal(drip.status, 408, `drip: ${drip.status} after ${drip.ms} ms`);
    assert.ok(drip.ms <= 3_000, `408 after ${drip.ms} ms`);
    assert.ok(drip.closedMs !== undefined && drip.closedMs <= 3_500);
  } finally {
    await network?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
