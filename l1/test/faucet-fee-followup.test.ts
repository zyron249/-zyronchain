// Follow-up to #1137 (Security lows A and B): the faucet and smoke cap the fee
// they will pay at MAX_FAUCET_FEE_ATOMS, and pay exactly the fixed fee when the
// node reports fixedTransferFeeAtoms (fee-v1).
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);
const ok = (body: Record<string, unknown>) => ({ status: 200, body: { height: 3, ...body } });
const isFeeFloor = (error: unknown) => error instanceof api.FaucetFeeFloorError && (error as any).code === "fee-floor";

test("FAUCET-FEE-CAP: MAX_FAUCET_FEE_ATOMS is exported as 1,000,000 atoms", () => {
  assert.equal(api.MAX_FAUCET_FEE_ATOMS, 1_000_000);
});

test("FAUCET-FEE-CAP: a node floor at the cap is paid, above the cap fails with fee-floor", () => {
  const cap = api.MAX_FAUCET_FEE_ATOMS as number;
  assert.equal(api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: cap, fixedTransferFeeAtoms: null })), cap);
  assert.throws(() => api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: cap + 1, fixedTransferFeeAtoms: null })), isFeeFloor);
  assert.throws(() => api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: Number.MAX_SAFE_INTEGER, fixedTransferFeeAtoms: null })), isFeeFloor);
  assert.throws(() => api.faucetTransferFeeAtoms(cap + 1, ok({ minTransferFeeAtoms: 0, fixedTransferFeeAtoms: null })), isFeeFloor, "the env floor is capped too");
});

test("FAUCET-FEE-FIXED: under fee-v1 the faucet pays exactly fixedTransferFeeAtoms", () => {
  assert.equal(api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: 0, fixedTransferFeeAtoms: 1_000 })), 1_000);
  assert.equal(api.faucetTransferFeeAtoms(5_000, ok({ minTransferFeeAtoms: 0, fixedTransferFeeAtoms: 1_000 })), 1_000, "env floor must not override the exact fee");
  assert.equal(api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: 9_000, fixedTransferFeeAtoms: 2_000 })), 2_000, "floor logic is bypassed");
});

test("FAUCET-FEE-FIXED: an invalid or over-cap fixed fee fails with fee-floor", () => {
  const cap = api.MAX_FAUCET_FEE_ATOMS as number;
  for (const fixed of [cap + 1, -1, "1000", 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: 0, fixedTransferFeeAtoms: fixed })), isFeeFloor, String(fixed));
  }
  assert.equal(api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: 0, fixedTransferFeeAtoms: cap })), cap);
});

async function postFaucet(route: (req: IncomingMessage, res: any, ip: string) => Promise<void>) {
  const server: Server = createServer((req, res) => { void route(req, res, "127.0.0.1"); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    return await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: (server.address() as AddressInfo).port, path: "/faucet", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        let text = ""; res.setEncoding("utf8"); res.on("data", (c) => { text += c; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      });
      req.on("error", reject); req.end(JSON.stringify({ address: `ZYN${"a".repeat(40)}` }));
    });
  } finally { await new Promise<void>((done) => server.close(() => done())); }
}

test("FAUCET-FEE-CAP: an over-cap floor returns 503 fee-floor, logs at error level and sends no transfer", async () => {
  const open = () => ({ take: () => ({ allowed: true, retryAfterMs: 0 }) });
  const logged: string[] = []; let transfers = 0;
  const route = api.createFaucetRoute({
    origins: new Set<string>(), limits: { faucetIp: open(), faucetAddress: open(), faucetGlobal: open() },
    faucetAddress: `ZYN${"b".repeat(40)}`,
    readJsonBody: async (request: IncomingMessage) => { const chunks: Buffer[] = []; for await (const c of request) chunks.push(c as Buffer); return JSON.parse(Buffer.concat(chunks).toString("utf8")); },
    send: async () => { const fee = api.faucetTransferFeeAtoms(0, ok({ minTransferFeeAtoms: api.MAX_FAUCET_FEE_ATOMS + 1, fixedTransferFeeAtoms: null })); transfers += 1; return { fee }; },
    log: (line: string) => logged.push(line)
  });
  const reply = await postFaucet(route);
  assert.equal(reply.status, 503);
  assert.equal(reply.body.code, "fee-floor");
  assert.match(reply.body.error, /MAX_FAUCET_FEE_ATOMS/);
  assert.equal(transfers, 0);
  assert.equal(logged.length, 1);
  assert.match(logged[0]!, /^faucet error \(fee floor\): /);
});
