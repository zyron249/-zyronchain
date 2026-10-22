// POST /faucet spends a per-IP daily quota, so a browser on an arbitrary site
// must not be able to call it: only allowed origins get
// Access-Control-Allow-Origin (preflight and response), every faucet response
// carries Vary: Origin, and a failed drip never echoes the node's error text.
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
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
