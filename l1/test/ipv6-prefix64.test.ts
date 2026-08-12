import assert from "node:assert/strict";
import test from "node:test";

import { ipv6Prefix64 } from "../src/p2p-address.js";

test("ipv6Prefix64 canonicalizes compressed and expanded addresses in one /64", () => {
  assert.equal(ipv6Prefix64("2001:db8:1234:5678::1"), "2001:0db8:1234:5678");
  assert.equal(ipv6Prefix64("2001:0db8:1234:5678:abcd:ef01:2345:6789"), "2001:0db8:1234:5678");
  assert.equal(ipv6Prefix64("2001:DB8:1234:5678::1"), "2001:0db8:1234:5678");
});

test("ipv6Prefix64 keeps distinct /64 prefixes distinct", () => {
  assert.notEqual(
    ipv6Prefix64("2001:db8:1234:5678::1"),
    ipv6Prefix64("2001:db8:1234:5679::1")
  );
});

test("ipv6Prefix64 canonicalizes IPv4-embedded IPv6 forms", () => {
  assert.equal(ipv6Prefix64("2001:db8::192.0.2.1"), "2001:0db8:0000:0000");
  assert.equal(ipv6Prefix64("2001:0db8:0:0:0:0:c000:0201"), "2001:0db8:0000:0000");
});
