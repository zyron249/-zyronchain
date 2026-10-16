// P1-02 (RPC limits review): rate-limit client identity.
//
// 1. Node RPC: one IPv6 end site normally holds at least a /64, so bucketing
//    IPv6 clients per /128 gives one host up to 2^64 independent quotas and
//    lets it fill the limiter's tracked-identity table, pushing every new
//    client into the shared overflow quota. IPv6 clients share one bucket per
//    /64 (IPv4 stays per address).
// 2. Public gateways (scripts/open-testnet.mjs, scripts/public-testnet-rpc.mjs):
//    the client identity must never come from the client-controlled leftmost
//    X-Forwarded-For entry. Behind Cloudflare (Render), CF-Connecting-IP is
//    set by the edge; behind a loopback proxy, the proxy appends the address
//    it saw as the rightmost entry. Anything else fails closed to the
//    transport peer's bucket.
import assert from "node:assert/strict";
import test from "node:test";

import { clientAddressBucket, gatewayClientIdentity } from "../src/rpc-client-identity.js";
import { FixedWindowLimiter } from "../src/rpc-rate-limit.js";
import { rpcRateLimitIdentity } from "../src/node-base.js";

test("node RPC buckets direct IPv6 clients per /64", () => {
  const a = rpcRateLimitIdentity("2001:db8:1:2::1", undefined, []);
  const b = rpcRateLimitIdentity("2001:db8:1:2:ffff:ffff:ffff:fffe", undefined, []);
  const other = rpcRateLimitIdentity("2001:db8:1:3::1", undefined, []);
  assert.equal(a, b);
  assert.notEqual(a, other);
  assert.equal(a, "ipv6:2001:0db8:0001:0002/64");
});

test("node RPC buckets forwarded IPv6 clients behind a trusted proxy per /64", () => {
  const trusted = ["10.0.0.2"];
  assert.equal(
    rpcRateLimitIdentity("10.0.0.2", "2001:db8::7", trusted),
    rpcRateLimitIdentity("10.0.0.2", "2001:db8::abcd:1", trusted)
  );
  assert.equal(rpcRateLimitIdentity("10.0.0.2", "2001:db8::7", trusted), "ipv6:2001:0db8:0000:0000/64");
});

test("node RPC keeps IPv4 and IPv4-mapped clients per address", () => {
  assert.equal(rpcRateLimitIdentity("203.0.113.10", undefined, []), "203.0.113.10");
  assert.equal(rpcRateLimitIdentity("::ffff:203.0.113.10", undefined, []), "203.0.113.10");
  assert.notEqual(rpcRateLimitIdentity("203.0.113.10", undefined, []), rpcRateLimitIdentity("203.0.113.11", undefined, []));
});

test("one /64 cannot multiply its quota or fill the tracked-identity table", () => {
  const limiter = new FixedWindowLimiter(3, 60_000, 8);
  let allowed = 0;
  for (let host = 1; host <= 1_000; host += 1) {
    const identity = rpcRateLimitIdentity(`2001:db8:5:6::${host.toString(16)}`, undefined, []);
    if (limiter.consume(identity, 1_000).allowed) allowed += 1;
  }
  assert.equal(allowed, 3);
  assert.equal(limiter.trackedIdentityCount, 1);
  // A different client still has its own full quota.
  assert.equal(limiter.consume(rpcRateLimitIdentity("198.51.100.20", undefined, []), 1_001).allowed, true);
});

test("clientAddressBucket accepts only IP literals", () => {
  assert.equal(clientAddressBucket("198.51.100.7"), "198.51.100.7");
  assert.equal(clientAddressBucket(" ::FFFF:198.51.100.7 "), "198.51.100.7");
  assert.equal(clientAddressBucket("[2001:DB8::1]"), "ipv6:2001:0db8:0000:0000/64");
  for (const bad of ["", "unknown", "example.com", "198.51.100.7:80", "1.2.3", "2001:db8:::1", "fe80::1%eth0", "x".repeat(100)]) {
    assert.equal(clientAddressBucket(bad), undefined, bad);
  }
});

test("gateway ignores forwarding headers from a direct non-loopback client", () => {
  const headers = { "x-forwarded-for": "203.0.113.99", "cf-connecting-ip": "203.0.113.98" };
  assert.equal(gatewayClientIdentity("198.51.100.7", headers, { trustCloudflareConnectingIp: false }), "198.51.100.7");
});

test("gateway never uses the client-controlled leftmost X-Forwarded-For entry", () => {
  const options = { trustCloudflareConnectingIp: false };
  // A loopback proxy appends the address it saw; the left part is client text.
  const spoofed = gatewayClientIdentity("127.0.0.1", { "x-forwarded-for": "203.0.113.99, 198.51.100.7" }, options);
  assert.equal(spoofed, "198.51.100.7");
  const rotating = new Set<string>();
  for (let index = 0; index < 50; index += 1) {
    rotating.add(gatewayClientIdentity("127.0.0.1", { "x-forwarded-for": `10.9.${index}.1, 198.51.100.7` }, options));
  }
  assert.deepEqual([...rotating], ["198.51.100.7"]);
});

test("gateway without a trusted Cloudflare edge ignores a client-supplied CF-Connecting-IP", () => {
  const options = { trustCloudflareConnectingIp: false };
  assert.equal(
    gatewayClientIdentity("127.0.0.1", { "cf-connecting-ip": "203.0.113.99", "x-forwarded-for": "198.51.100.7" }, options),
    "198.51.100.7"
  );
  assert.equal(gatewayClientIdentity("198.51.100.8", { "cf-connecting-ip": "203.0.113.99" }, options), "198.51.100.8");
});

test("gateway behind a trusted Cloudflare edge uses CF-Connecting-IP and fails closed without it", () => {
  const options = { trustCloudflareConnectingIp: true };
  const proxy = "10.204.1.9";
  assert.equal(gatewayClientIdentity(proxy, { "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "203.0.113.99, 198.51.100.7, 10.0.0.1" }, options), "198.51.100.7");
  assert.equal(gatewayClientIdentity(proxy, { "cf-connecting-ip": "2001:db8:1:2::9" }, options), "ipv6:2001:0db8:0001:0002/64");
  // Missing, malformed or repeated header: shared bucket of the transport peer, never attacker text.
  assert.equal(gatewayClientIdentity(proxy, {}, options), `proxy:${proxy}`);
  assert.equal(gatewayClientIdentity(proxy, { "x-forwarded-for": "203.0.113.99" }, options), `proxy:${proxy}`);
  assert.equal(gatewayClientIdentity(proxy, { "cf-connecting-ip": "not-an-ip" }, options), `proxy:${proxy}`);
  assert.equal(gatewayClientIdentity(proxy, { "cf-connecting-ip": ["198.51.100.7", "198.51.100.8"] }, options), `proxy:${proxy}`);
});

test("gateway loopback proxy with malformed or oversized forwarding falls back to the proxy bucket", () => {
  const options = { trustCloudflareConnectingIp: false };
  assert.equal(gatewayClientIdentity("127.0.0.1", {}, options), "proxy:127.0.0.1");
  assert.equal(gatewayClientIdentity("::1", { "x-forwarded-for": "198.51.100.7, garbage" }, options), "proxy:ipv6:0000:0000:0000:0000/64");
  assert.equal(gatewayClientIdentity("127.0.0.1", { "x-forwarded-for": `${"1.1.1.1, ".repeat(400)}198.51.100.7` }, options), "proxy:127.0.0.1");
  assert.equal(gatewayClientIdentity(undefined, {}, options), "unknown");
});
