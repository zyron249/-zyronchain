import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import {
  diversityOrderedNativePeers,
  nativePeerDiversityBucket,
  parseNativePeerGroup,
  parseNativeListenAddress,
  parseNativePeerAddress
} from "../src/p2p-address.js";

const peerId = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from("01".padStart(64, "0"), "hex"))).toString();
const peerIdTwo = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from("02".padStart(64, "0"), "hex"))).toString();
const peerIdThree = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from("03".padStart(64, "0"), "hex"))).toString();
const peerIdFour = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from("04".padStart(64, "0"), "hex"))).toString();

test("native CLI address policy requires TCP and pins outbound PeerId", () => {
  assert.equal(parseNativeListenAddress("/ip4/0.0.0.0/tcp/9140"), "/ip4/0.0.0.0/tcp/9140");
  assert.equal(
    parseNativePeerAddress(`/dns4/node.example/tcp/9140/p2p/${peerId}`).toString(),
    `/dns4/node.example/tcp/9140/p2p/${peerId}`
  );
  assert.throws(() => parseNativePeerAddress("/ip4/127.0.0.1/tcp/9140"), /pin exactly one/);
  assert.throws(() => parseNativeListenAddress(`/ip4/0.0.0.0/tcp/9140/p2p/${peerId}`), /must not include/);
  assert.throws(() => parseNativeListenAddress("/ip4/0.0.0.0/udp/9140"), /host \+ TCP/);
});

test("native peer failure-domain hooks separate same-provider candidates", () => {
  const first = parseNativePeerAddress(`/ip4/10.0.1.1/tcp/9140/p2p/${peerId}`);
  const sameProvider = parseNativePeerAddress(`/ip4/10.0.2.1/tcp/9140/p2p/${peerIdTwo}`);
  const otherProvider = parseNativePeerAddress(`/ip4/10.0.3.1/tcp/9140/p2p/${peerIdThree}`);
  const otherProviderSecond = parseNativePeerAddress(`/ip4/10.0.4.1/tcp/9140/p2p/${peerIdFour}`);
  const groups = new Map([
    [peerId, "provider-a"],
    [peerIdTwo, "provider-a"],
    [peerIdThree, "provider-b"],
    [peerIdFour, "provider-b"]
  ]);
  const ordered = diversityOrderedNativePeers([first, sameProvider, otherProvider, otherProviderSecond], 0, groups);
  assert.deepEqual(ordered.slice(0, 2).map((peer) => groups.get(peer.getComponents()[2]!.value!)), ["provider-a", "provider-b"]);
  assert.deepEqual(parseNativePeerGroup(`${peerId}=asn-64500`), { peerId, group: "asn-64500" });
  assert.throws(() => parseNativePeerGroup(`${peerId}=bad group`), /group label/);
});

test("native peer ordering interleaves subnet/host buckets and rotates the first group", () => {
  const subnetA = parseNativePeerAddress(`/ip4/10.20.30.1/tcp/9140/p2p/${peerId}`);
  const subnetASecond = parseNativePeerAddress(`/ip4/10.20.30.99/tcp/9140/p2p/${peerId}`);
  const subnetB = parseNativePeerAddress(`/ip4/10.20.31.1/tcp/9140/p2p/${peerId}`);
  const dns = parseNativePeerAddress(`/dns4/node.example/tcp/9140/p2p/${peerId}`);
  assert.equal(nativePeerDiversityBucket(subnetA), "ipv4:10.20.30.0/24");
  assert.deepEqual(
    diversityOrderedNativePeers([subnetA, subnetASecond, subnetB, dns]).map((peer) => peer.toString()),
    [subnetA, subnetB, dns, subnetASecond].map((peer) => peer.toString())
  );
  assert.deepEqual(
    diversityOrderedNativePeers([subnetA, subnetASecond, subnetB, dns], 1).slice(0, 3).map(nativePeerDiversityBucket),
    ["ipv4:10.20.31.0/24", "host:node.example", "ipv4:10.20.30.0/24"]
  );
});

test("native IPv6 diversity groups one /64 instead of treating every address as independent", () => {
  const same64a = parseNativePeerAddress(`/ip6/2001:4860:4860:0::1/tcp/9140/p2p/${peerId}`);
  const same64b = parseNativePeerAddress(`/ip6/2001:4860:4860:0::abcd/tcp/9140/p2p/${peerIdTwo}`);
  const other64 = parseNativePeerAddress(`/ip6/2001:4860:4860:1::1/tcp/9140/p2p/${peerIdThree}`);
  assert.equal(nativePeerDiversityBucket(same64a), "ipv6:2001:4860:4860:0000/64");
  assert.equal(nativePeerDiversityBucket(same64b), nativePeerDiversityBucket(same64a));
  assert.notEqual(nativePeerDiversityBucket(other64), nativePeerDiversityBucket(same64a));
  assert.deepEqual(
    diversityOrderedNativePeers([same64a, same64b, other64]).map((peer) => peer.toString()),
    [same64a, other64, same64b].map((peer) => peer.toString())
  );
});
