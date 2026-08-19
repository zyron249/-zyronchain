import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRpcTrustedProxyConfiguration,
  MAX_RPC_FORWARDED_HOPS,
  MAX_RPC_TRUSTED_PROXIES,
  rpcRateLimitIdentity
} from "../src/node-base.js";

test("direct RPC clients cannot spoof rate-limit identity with forwarding headers", () => {
  assert.equal(
    rpcRateLimitIdentity("203.0.113.10", "198.51.100.7", []),
    "203.0.113.10"
  );
});

test("trusted HTTPS proxy resolves distinct client identities", () => {
  const trusted = ["10.0.0.2"];
  assert.equal(rpcRateLimitIdentity("10.0.0.2", "198.51.100.7", trusted), "198.51.100.7");
  assert.equal(rpcRateLimitIdentity("10.0.0.2", "198.51.100.8", trusted), "198.51.100.8");
});

test("trusted proxy chains are walked from the trusted edge toward the client", () => {
  const trusted = ["10.0.0.2", "10.0.0.3"];
  assert.equal(
    rpcRateLimitIdentity("10.0.0.2", "198.51.100.7, 10.0.0.3", trusted),
    "198.51.100.7"
  );
});

test("malformed or fully trusted forwarded chains fail closed to the proxy bucket", () => {
  const trusted = ["10.0.0.2", "10.0.0.3"];
  assert.equal(rpcRateLimitIdentity("10.0.0.2", "not-an-ip", trusted), "proxy:10.0.0.2");
  assert.equal(rpcRateLimitIdentity("10.0.0.2", "10.0.0.3", trusted), "proxy:10.0.0.2");
  assert.equal(rpcRateLimitIdentity("10.0.0.2", undefined, trusted), "proxy:10.0.0.2");
});

test("forwarded chains accept the exact hop bound and reject over-bound chains to the proxy bucket", () => {
  const proxy = "10.0.0.2";
  const trusted = [proxy];
  const exact = Array.from({ length: MAX_RPC_FORWARDED_HOPS }, (_, index) =>
    index === 0 ? "198.51.100.7" : proxy
  ).join(", ");
  assert.equal(rpcRateLimitIdentity(proxy, exact, trusted), "198.51.100.7");

  const overBound = `${exact}, ${proxy}`;
  assert.equal(rpcRateLimitIdentity(proxy, overBound, trusted), `proxy:${proxy}`);
});

test("invalid forwarded hops inside the accepted cardinality fail closed", () => {
  const proxy = "10.0.0.2";
  assert.equal(
    rpcRateLimitIdentity(proxy, `198.51.100.7, invalid-hop, ${proxy}`, [proxy]),
    `proxy:${proxy}`
  );
  assert.equal(
    rpcRateLimitIdentity(proxy, `198.51.100.7,,${proxy}`, [proxy]),
    `proxy:${proxy}`
  );
});

test("trusted RPC proxy configuration has an explicit startup cardinality bound", () => {
  const exact = Array.from({ length: MAX_RPC_TRUSTED_PROXIES }, (_, index) => `10.0.0.${index + 1}`);
  assert.doesNotThrow(() => assertRpcTrustedProxyConfiguration(exact));
  assert.throws(
    () => assertRpcTrustedProxyConfiguration([...exact, "10.0.1.1"]),
    /Too many configured trusted RPC proxies/
  );
});

test("IPv4-mapped proxy and client addresses normalize before bucketing", () => {
  assert.equal(
    rpcRateLimitIdentity("::ffff:10.0.0.2", "::ffff:198.51.100.7", ["10.0.0.2"]),
    "198.51.100.7"
  );
});
