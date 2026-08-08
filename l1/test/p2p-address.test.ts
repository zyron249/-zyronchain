import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyFromRaw } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";

import {
  diversityOrderedNativePeers,
  nativePeerDiversityBucket,
  parseNativeListenAddress,
  parseNativePeerAddress
} from "../src/p2p-address.js";

const peerId = peerIdFromPrivateKey(privateKeyFromRaw(Buffer.from("01".padStart(64, "0"), "hex"))).toString();

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
