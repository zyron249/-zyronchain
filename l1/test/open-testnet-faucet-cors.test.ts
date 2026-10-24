// POST /faucet spends a per-IP daily quota, so a browser on an arbitrary site
// must not be able to call it: only allowed origins get
// Access-Control-Allow-Origin (preflight and response), every faucet response
// carries Vary: Origin, and a failed drip never echoes the node's error text.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);

const ALLOWED = new Set<string>(api.DEFAULT_FAUCET_ALLOWED_ORIGINS);
const ADDRESS = `ZYN${"a".repeat(40)}`;
const open = () => ({ take: () => ({ allowed: true, retryAfterMs: 0 }) });

async function readJsonBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function gateway(send: (address: string) => Promise<unknown>, logs: string[] = []) {
  const route = api.createFaucetRoute({ origins: ALLOWED, limits: { faucetIp: open(), faucetAddress: open(), faucetGlobal: open() }, faucetAddress: `ZYN${"f".repeat(40)}`, readJsonBody, send, log: (line: string) => logs.push(line) });
  const server: Server = createServer((request, response) => {
    if (request.method === "OPTIONS") { response.writeHead(204, api.faucetCorsHeaders(request.headers.origin, ALLOWED)); response.end(); return; }
    void route(request, response, "198.51.100.7");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}
const post = (base: string, origin?: string) => fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify({ address: ADDRESS }) });

test("default faucet origins are zyronchain.com and the gateway's own explorer page", () => {
  assert.deepEqual([...api.parseFaucetAllowedOrigins(undefined)], ["https://zyronchain.com", "https://zyron-open-testnet.onrender.com"]);
  assert.deepEqual([...api.parseFaucetAllowedOrigins("")], ["https://zyronchain.com", "https://zyron-open-testnet.onrender.com"]);
});

test("ZYRON_FAUCET_ALLOWED_ORIGINS overrides the list and rejects non-origins", () => {
  assert.deepEqual([...api.parseFaucetAllowedOrigins(" https://a.example , http://localhost:8080/ ")], ["https://a.example", "http://localhost:8080"]);
  for (const bad of ["*", "https://a.example/path", "ftp://a.example", "zyronchain.com", " , "]) assert.throws(() => api.parseFaucetAllowedOrigins(bad), /ZYRON_FAUCET_ALLOWED_ORIGINS/);
});

test("preflight: allowed origin is echoed exactly; others get no ACAO; Vary: Origin always", async () => {
  const gw = await gateway(async () => ({ txid: "t" }));
  try {
    for (const origin of ALLOWED) {
      const r = await fetch(`${gw.base}/faucet`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
      assert.equal(r.status, 204);
      assert.equal(r.headers.get("access-control-allow-origin"), origin);
      assert.match(r.headers.get("access-control-allow-methods") ?? "", /POST/);
      assert.equal(r.headers.get("access-control-allow-headers"), "content-type");
      assert.match(r.headers.get("vary") ?? "", /Origin/);
    }
    for (const origin of ["https://evil.example", "https://zyronchain.com.evil.example", "http://zyronchain.com", "null"]) {
      const r = await fetch(`${gw.base}/faucet`, { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
      assert.equal(r.headers.get("access-control-allow-origin"), null, origin);
      assert.equal(r.headers.get("access-control-allow-methods"), null, origin);
      assert.match(r.headers.get("vary") ?? "", /Origin/);
    }
  } finally { await gw.close(); }
});

test("POST /faucet: ACAO only for allowed origins, never '*', Vary: Origin", async () => {
  const gw = await gateway(async (receiver) => ({ txid: "tx1", receiver }));
  try {
    const ok = await post(gw.base, "https://zyronchain.com");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://zyronchain.com");
    assert.match(ok.headers.get("vary") ?? "", /Origin/);
    for (const origin of ["https://evil.example", undefined]) {
      const r = await post(gw.base, origin);
      assert.equal(r.headers.get("access-control-allow-origin"), null, String(origin));
      assert.match(r.headers.get("vary") ?? "", /Origin/);
    }
  } finally { await gw.close(); }
});

test("a failed drip returns a generic 503 and logs the node error server-side", async () => {
  const logs: string[] = [];
  const secret = "nonce too low: account ZYNdeadbeef internal mempool detail";
  const gw = await gateway(async () => { throw Object.assign(new Error(`faucet transfer rejected by node (status 400): ${secret}`), { statusCode: 503 }); }, logs);
  try {
    const r = await post(gw.base, "https://zyronchain.com");
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.equal(JSON.parse(text).error, api.FAUCET_UNAVAILABLE_MESSAGE);
    assert.ok(!text.includes("nonce too low") && !text.includes("rejected by node"), text);
    assert.equal(r.headers.get("access-control-allow-origin"), "https://zyronchain.com");
    assert.ok(logs.some((line) => line.includes(secret)), "detail is logged");
  } finally { await gw.close(); }
});

test("an unexpected faucet exception is not echoed either", async () => {
  const logs: string[] = [];
  const gw = await gateway(async () => { throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:19001"); }, logs);
  try {
    const r = await post(gw.base);
    assert.equal(r.status, 503);
    const text = await r.text();
    assert.ok(!text.includes("ECONNREFUSED"), text);
    assert.ok(logs.some((line) => line.includes("ECONNREFUSED")));
  } finally { await gw.close(); }
});

test("cross-site no-cors POSTs are refused before any quota is taken", async () => {
  let takes = 0;
  let sends = 0;
  const counting = () => { let used = 0; return { take: () => { takes += 1; used += 1; return used <= 5 ? { allowed: true, retryAfterMs: 0 } : { allowed: false, retryAfterMs: 1000 }; } }; };
  const route = api.createFaucetRoute({ origins: ALLOWED, limits: { faucetIp: counting(), faucetAddress: open(), faucetGlobal: open() }, faucetAddress: `ZYN${"f".repeat(40)}`, readJsonBody, send: async () => { sends += 1; return { txid: "t" }; }, log: () => {} });
  const server: Server = createServer((request, response) => { void route(request, response, "198.51.100.7"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const body = JSON.stringify({ address: ADDRESS });
  try {
    const attacks: Array<[string, string]> = [["https://evil.example", "text/plain"], ["null", "application/x-www-form-urlencoded"], ["https://evil.example", "application/json"]];
    for (const [origin, type] of attacks) {
      for (let i = 0; i < 5; i += 1) {
        const r = await fetch(`${base}/faucet`, { method: "POST", headers: { origin, "content-type": type }, body });
        assert.equal(r.status, 403, `${origin} ${type}`);
        assert.equal(r.headers.get("access-control-allow-origin"), null);
        assert.match(r.headers.get("vary") ?? "", /Origin/);
        await r.arrayBuffer();
      }
    }
    assert.equal(takes, 0, "quota untouched by cross-site requests");
    assert.equal(sends, 0);
    // Behavior change (Security): a same-host Origin is no longer trusted.
    const sameHost = await post(base, `http://127.0.0.1:${port}`);
    assert.equal(sameHost.status, 403);
    await sameHost.arrayBuffer();
    assert.equal(takes, 0, "same-host 403 takes no quota");
    for (const origin of ["https://zyronchain.com", undefined]) {
      const r = await post(base, origin);
      assert.equal(r.status, 200, String(origin));
      await r.arrayBuffer();
    }
    assert.equal(takes, 2);
    const plain = await fetch(`${base}/faucet`, { method: "POST", headers: { "content-type": "text/plain" }, body });
    assert.equal(plain.status, 415);
    await plain.arrayBuffer();
    assert.equal(takes, 2, "415 does not take quota");
  } finally { await new Promise((done) => server.close(done)); }
});

async function countingGateway() {
  const state = { takes: 0, sends: 0 };
  const route = api.createFaucetRoute({ origins: ALLOWED, limits: { faucetIp: { take: () => { state.takes += 1; return { allowed: true, retryAfterMs: 0 }; } }, faucetAddress: open(), faucetGlobal: open() }, faucetAddress: `ZYN${"f".repeat(40)}`, readJsonBody, send: async () => { state.sends += 1; return { txid: "t" }; }, log: () => {} });
  const server: Server = createServer((request, response) => { void route(request, response, "198.51.100.7"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { state, port, base: `http://127.0.0.1:${port}`, close: () => new Promise((done) => server.close(done)) };
}
// Raw http.request so the Host header can be set (fetch forbids it).
function rawPost(port: number, headers: Record<string, string>): Promise<{ status: number; acao: string | undefined }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path: "/faucet", headers: { "content-type": "application/json", ...headers } }, (res) => { res.resume(); res.on("end", () => resolve({ status: res.statusCode ?? 0, acao: res.headers["access-control-allow-origin"] as string | undefined })); });
    req.on("error", reject);
    req.end(JSON.stringify({ address: ADDRESS }));
  });
}

test("a same-host Origin that is not allowlisted is refused with 403 and takes no quota", async () => {
  const gw = await countingGateway();
  try {
    for (const host of [`127.0.0.1:${gw.port}`, "localhost"]) {
      const origin = `http://${host}`;
      const r = await rawPost(gw.port, { host, origin });
      assert.equal(r.status, 403, origin);
      assert.equal(r.acao, undefined);
    }
    assert.equal(gw.state.takes, 0);
    assert.equal(gw.state.sends, 0);
  } finally { await gw.close(); }
});

test("DNS-rebinding style request (Host evil.example, Origin http://evil.example) is refused", async () => {
  const gw = await countingGateway();
  try {
    for (const [host, origin] of <Array<[string, string]>>[["evil.example", "http://evil.example"], ["evil.example:80", "http://evil.example:80"], ["evil.example", "https://evil.example"]]) {
      const r = await rawPost(gw.port, { host, origin });
      assert.equal(r.status, 403, `${host} ${origin}`);
      assert.equal(r.acao, undefined);
    }
    assert.equal(gw.state.takes, 0);
  } finally { await gw.close(); }
});

test("port-normalized forms of allowed origins are accepted", async () => {
  assert.equal(api.normalizeFaucetOrigin("https://zyronchain.com:443"), "https://zyronchain.com");
  assert.equal(api.normalizeFaucetOrigin("http://localhost:80"), "http://localhost");
  assert.equal(api.normalizeFaucetOrigin("HTTPS://ZyronChain.com"), "https://zyronchain.com");
  assert.equal(api.normalizeFaucetOrigin("https://zyronchain.com:8443"), "https://zyronchain.com:8443");
  for (const bad of ["null", "https://zyronchain.com/x", "https://u@zyronchain.com", "https://zyronchain.com?q", "ftp://zyronchain.com", undefined]) assert.equal(api.normalizeFaucetOrigin(bad), null, String(bad));
  assert.deepEqual([...api.parseFaucetAllowedOrigins("https://a.example:443, http://b.example:80/, http://c.example:8080")], ["https://a.example", "http://b.example", "http://c.example:8080"]);
  const local = api.parseFaucetAllowedOrigins("http://localhost:80");
  assert.ok(api.faucetOriginAllowed("http://localhost", local));
  assert.ok(api.faucetOriginAllowed("http://localhost:80", local));
  assert.ok(!api.faucetOriginAllowed("http://localhost:8080", local));
  assert.ok(!api.faucetOriginAllowed("https://localhost", local));
  const gw = await countingGateway();
  try {
    for (const origin of ["https://zyronchain.com:443", "https://zyron-open-testnet.onrender.com:443", "https://zyronchain.com"]) {
      const r = await rawPost(gw.port, { origin });
      assert.equal(r.status, 200, origin);
      assert.equal(r.acao, origin, "ACAO echoes the exact Origin");
    }
    for (const origin of ["http://zyronchain.com:80", "https://zyronchain.com:8443"]) {
      const r = await rawPost(gw.port, { origin });
      assert.equal(r.status, 403, origin);
    }
    assert.equal(gw.state.takes, 3);
  } finally { await gw.close(); }
});
