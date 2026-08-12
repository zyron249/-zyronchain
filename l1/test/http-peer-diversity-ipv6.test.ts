import assert from "node:assert/strict";
import test from "node:test";

import { diversityOrderedPeers, peerDiversityBucket } from "../src/node-base.js";

test("HTTP IPv6 peers in the same /64 share one diversity bucket", () => {
  const a = "https://[2001:db8:abcd:1234::1]:9137";
  const b = "https://[2001:db8:abcd:1234::ffff]:9137";
  assert.equal(peerDiversityBucket(a), "ipv6:2001:0db8:abcd:1234/64");
  assert.equal(peerDiversityBucket(a), peerDiversityBucket(b));
});

test("HTTP IPv6 peers from different /64 prefixes remain distinct", () => {
  const a = "https://[2001:db8:abcd:1234::1]:9137";
  const b = "https://[2001:db8:abcd:1235::1]:9137";
  assert.notEqual(peerDiversityBucket(a), peerDiversityBucket(b));
});

test("HTTP peer ordering interleaves IPv6 failure domains instead of individual addresses", () => {
  const samePrefixA = "https://[2001:db8:abcd:1234::1]:9137";
  const samePrefixB = "https://[2001:db8:abcd:1234::2]:9137";
  const otherPrefix = "https://[2001:db8:abcd:9999::1]:9137";
  assert.deepEqual(
    diversityOrderedPeers([samePrefixA, samePrefixB, otherPrefix]),
    [samePrefixA, otherPrefix, samePrefixB]
  );
});
