#!/usr/bin/env node
// External-validator side of the open TESTNET consensus relay
// (docs/CONSENSUS_RELAY.md). Outbound HTTPS only. Holds only the relay
// transport key, never the validator key; it moves bytes between the local
// node and the gateway and does not inspect or change votes.
//
//   node scripts/consensus-relay-client.mjs keygen --out <relay-key.hex>
//   node scripts/consensus-relay-client.mjs run --gateway https://<host> --address ZYN... \
//     --relay-key <relay-key.hex> --expected-genesis <hash> [--node http://127.0.0.1:9137] [--listen 19540] [--hosted 4]
// The local node then uses `--peer http://127.0.0.1:<listen>/h/<i>` for i = 0..hosted-1.
import { createServer } from "node:http";
import { chmod, open, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelayAuthHeader, relayPublicKey, RELAY_AUTH_HEADER, RELAY_CONSENSUS_PATHS, RELAY_MAX_CONSENSUS_REQUEST_BYTES, RELAY_MAX_REPLY_BYTES } from "./open-testnet/consensus-relay.mjs";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { generatePrivateKey } = await import(join(l1Root, "dist/src/crypto.js"));

function option(args, name, fallback) {
  const i = args.indexOf(name);
  if (i === -1) { if (fallback === undefined) throw new Error(`missing ${name}`); return fallback; }
  return args[i + 1];
}

async function readRelayKey(path) {
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) throw new Error("relay key file must not be readable by group or others (chmod 600)");
  const key = (await readFile(path, "utf8")).trim();
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("relay key file must hold one 64-hex private key");
  return key;
}

export function createRelayClient({ gateway, address, relayKey, chainId, genesisHash, nodeUrl, hosted = 4, fetchImpl = fetch, log = console.error }) {
  let counter = 0;
  const nextSeq = () => Date.now() * 1000 + (counter = (counter + 1) % 1000);
  async function call(op, payload, timeoutMs = 12_000) {
    const body = Buffer.from(JSON.stringify(payload));
    const auth = createRelayAuthHeader({ chainId, genesisHash, address, seq: nextSeq(), op, body }, relayKey);
    const response = await fetchImpl(`${gateway}/relay/v1/${op}`, { method: "POST", headers: { "content-type": "application/json", [RELAY_AUTH_HEADER]: auth }, body, signal: AbortSignal.timeout(timeoutMs) });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`relay ${op}: ${response.status} ${String(json.error ?? "").slice(0, 120)}`);
    return json;
  }
  async function serveRequest(request) {
    let status = 502; let bytes = Buffer.from('{"error":"local node unavailable"}');
    try {
      if (!RELAY_CONSENSUS_PATHS.includes(request.path)) throw new Error("path not allowed");
      const body = Buffer.from(request.body, "base64");
      if (body.length > RELAY_MAX_CONSENSUS_REQUEST_BYTES) throw new Error("request too large");
      const response = await fetchImpl(`${nodeUrl}${request.path}`, { method: "POST", headers: { "content-type": "application/json", "x-zyron-rpc-version": "1" }, body, signal: AbortSignal.timeout(5_500) });
      status = response.status; bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > RELAY_MAX_REPLY_BYTES[request.path]) { status = 502; bytes = Buffer.from('{"error":"reply too large"}'); }
    } catch (error) { log(`relay: local ${request.path} failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (request.path === "/block") return;
    await call("reply", { id: request.id, status, body: bytes.toString("base64") }).catch((error) => log(`relay: reply failed: ${error.message}`));
  }
  let stopped = false;
  async function pollLoop() {
    while (!stopped) {
      try {
        const { requests } = await call("poll", {});
        for (const request of requests ?? []) void serveRequest(request);
      } catch (error) {
        log(`relay: ${error.message}`);
        await new Promise((done) => setTimeout(done, 3_000));
      }
    }
  }
  // Local peer endpoint for the node: /h/<i>/<path>.
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 15_000 }, async (req, res) => {
    const send = (code, bytes) => { res.writeHead(code, { "content-type": "application/json", "content-length": bytes.length }); res.end(bytes); };
    try {
      const match = /^\/h\/(\d{1,2})(\/[a-z0-9/]*)(\?.*)?$/.exec(req.url ?? "");
      if (!match || Number(match[1]) >= hosted) return send(404, Buffer.from('{"error":"Not found"}'));
      const [, index, path, query = ""] = match;
      if (req.method === "GET" && (path === "/status" || path === "/blocks")) {
        const response = await fetchImpl(`${gateway}/peer${path}${query}`, { headers: { "x-zyron-rpc-version": "1" }, signal: AbortSignal.timeout(10_000) });
        return send(response.status, Buffer.from(await response.arrayBuffer()));
      }
      if (req.method !== "POST" || !RELAY_CONSENSUS_PATHS.includes(path)) return send(404, Buffer.from('{"error":"Not found"}'));
      let size = 0; const chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > RELAY_MAX_CONSENSUS_REQUEST_BYTES) return send(413, Buffer.from('{"error":"too large"}')); chunks.push(chunk); }
      const result = await call("forward", { target: Number(index), path, body: Buffer.concat(chunks).toString("base64") }, 9_000);
      return send(result.status, Buffer.from(result.body, "base64"));
    } catch (error) {
      return send(502, Buffer.from(JSON.stringify({ error: "relay unavailable" })));
    }
  });
  return {
    server,
    start(listenPort) { void pollLoop(); return new Promise((done) => server.listen(listenPort, "127.0.0.1", () => done(server.address().port))); },
    stop() { stopped = true; return new Promise((done) => server.close(() => done())); }
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "keygen") {
    const out = option(args, "--out");
    const key = generatePrivateKey();
    const handle = await open(out, "wx", 0o600);
    try { await handle.writeFile(`${key}\n`); } finally { await handle.close(); }
    await chmod(out, 0o600);
    console.log(`Relay public key: ${relayPublicKey(key)}`);
    return;
  }
  if (command !== "run") throw new Error("usage: consensus-relay-client.mjs keygen|run ...");
  const gateway = option(args, "--gateway").replace(/\/+$/, "");
  if (!/^https:\/\//.test(gateway) && !/^http:\/\/127\.0\.0\.1[:/]/.test(gateway)) throw new Error("--gateway must be https (or loopback http for tests)");
  const address = option(args, "--address");
  const expected = option(args, "--expected-genesis");
  const relayKey = await readRelayKey(option(args, "--relay-key"));
  const genesis = await (await fetch(`${gateway}/genesis`, { signal: AbortSignal.timeout(15_000) })).json();
  if (genesis.genesisHash !== expected) throw new Error(`gateway genesis ${genesis.genesisHash} does not match --expected-genesis; refusing`);
  const client = createRelayClient({ gateway, address, relayKey, chainId: genesis.genesis.chainId, genesisHash: genesis.genesisHash,
    nodeUrl: option(args, "--node", "http://127.0.0.1:9137"), hosted: Number(option(args, "--hosted", "4")) });
  const port = await client.start(Number(option(args, "--listen", "19540")));
  console.log(`consensus relay client on 127.0.0.1:${port} for ${address}; gateway ${gateway}; genesis ${genesis.genesisHash}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
}
