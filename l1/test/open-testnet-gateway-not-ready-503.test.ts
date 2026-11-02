// Regression (open testnet, 2026-11-01): while no validator answered (cold
// start / replay), GET /blocks?from=N&limit=2 and GET /status returned
// HTTP 500 {"error":"internal error"}: chainStatus() threw a plain
// "node not ready" Error and the gateway's catch-all mapped every untyped
// error to 500. A not-ready node is retryable and must be a 503 with
// retry-after and a clear message.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const scriptPath = join(l1Root, "scripts", "open-testnet.mjs");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(scriptPath).href);

test("gateway: node not ready maps to 503 with retry-after, not 500 internal error", () => {
  assert.equal(typeof api.nodeNotReadyError, "function");
  assert.equal(typeof api.gatewayErrorReply, "function");
  const reply = api.gatewayErrorReply(api.nodeNotReadyError());
  assert.equal(reply.code, 503);
  assert.deepEqual(reply.body, { error: "node not ready" });
  assert.equal(reply.headers["retry-after"], "5");
});

test("gateway: typed client errors keep their status; unknown errors stay a generic 500", () => {
  const typed = api.gatewayErrorReply(Object.assign(new Error("invalid JSON"), { statusCode: 400 }));
  assert.deepEqual([typed.code, typed.body], [400, { error: "invalid JSON" }]);
  assert.equal(typed.headers["retry-after"], undefined);
  const unknown = api.gatewayErrorReply(new TypeError("Cannot read properties of undefined (reading 'map')"));
  assert.deepEqual([unknown.code, unknown.body], [500, { error: "internal error" }]);
  const bogus = api.gatewayErrorReply(Object.assign(new Error("x"), { statusCode: 200 }));
  assert.equal(bogus.code, 500);
});

test("gateway: chainStatus, the GET catch-all and the block routes use the typed not-ready path", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /if \(status\.status !== 200\) throw nodeNotReadyError\(\);/);
  assert.doesNotMatch(source, /throw new Error\("node not ready"\)/);
  assert.match(source, /const reply = gatewayErrorReply\(error\);/);
  // A 200 without a blocks array from a validator is a 502, never a TypeError 500.
  assert.match(source, /const served = result\.status === 200 && Array\.isArray\(result\.body\?\.blocks\);/);
  assert.match(source, /result\.status !== 200 \|\| !Array\.isArray\(result\.body\?\.blocks\)/);
});
