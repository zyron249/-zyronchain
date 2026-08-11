import assert from "node:assert/strict";
import test from "node:test";

import { rpcRateLimitIdentity } from "../src/node-base.js";

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

test("IPv4-mapped proxy and client addresses normalize before bucketing", () => {
  assert.equal(
    rpcRateLimitIdentity("::ffff:10.0.0.2", "::ffff:198.51.100.7", ["10.0.0.2"]),
    "198.51.100.7"
  );
});
