import assert from "node:assert/strict";
import test from "node:test";

import { classifyRpcRoute } from "../src/public-testnet-rpc.js";
import { assertSafeRpcBinding, isTrustedHttpsProxyRequest, rpcRateLimitIdentity } from "../src/node-base.js";

test("AUDIT: RPC routes classified PUBLIC / CONSENSUS / OPERATOR / UNKNOWN", () => {
  const publicRoutes: Array<[string, string]> = [
    ["GET", "/rpc-info"], ["GET", "/status"], ["GET", "/protocol"],
    ["GET", "/healthz"], ["GET", "/readyz"],
    ["GET", "/balance/ZYNabc"], ["GET", "/nonce/ZYNabc"],
    ["POST", "/tx"]
  ];
  for (const [method, path] of publicRoutes) {
    assert.equal(classifyRpcRoute(method, path), "public", `${method} ${path}`);
  }
  const consensus = [
    "/proposal/prepare", "/proposal/attest", "/round/skip", "/round/view",
    "/round/prepare-report", "/round/lock", "/round/report", "/round/complete", "/block"
  ];
  for (const path of consensus) {
    assert.equal(classifyRpcRoute("POST", path), "consensus", path);
  }
  for (const path of ["/metrics", "/peers", "/peer-record", "/blocks"]) {
    assert.equal(classifyRpcRoute("GET", path), "operator", path);
  }
  assert.equal(classifyRpcRoute("POST", "/admin/shutdown"), "unknown");
  assert.equal(classifyRpcRoute("DELETE", "/tx"), "unknown");
});

test("AUDIT: non-loopback RPC requires consensus auth and trusted HTTPS proxy", () => {
  assert.throws(() => assertSafeRpcBinding("0.0.0.0", false, false), /consensus peer authentication/);
  assert.throws(() => assertSafeRpcBinding("0.0.0.0", true, false), /trusted proxy/);
  assert.doesNotThrow(() => assertSafeRpcBinding("127.0.0.1", false, false));
  assert.doesNotThrow(() => assertSafeRpcBinding("0.0.0.0", true, true));
});

test("AUDIT: empty trusted-proxy list ignores X-Forwarded-For for rate-limit identity", () => {
  const id = rpcRateLimitIdentity("203.0.113.10", "198.51.100.1", []);
  assert.equal(id, "203.0.113.10");
  assert.equal(isTrustedHttpsProxyRequest("203.0.113.10", "https", []), true);
  assert.equal(isTrustedHttpsProxyRequest("203.0.113.10", "http", ["203.0.113.10"]), false);
});
