import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { canonicalJson, sha256Hex } from "../src/codec.js";
import {
  loadOrCreateNodeIdentity,
  PeerRequestAuthenticator,
  signPeerRequest
} from "../src/peer-identity.js";

const chain = { chainId: "zyron-devnet-1", genesisHash: "ab".repeat(32) };
const request = { method: "POST", path: "/block" } as const;

test("one authenticated peer cannot exhaust replay capacity reserved for other peers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-replay-isolation-"));
  try {
    const dirs = [join(directory, "a"), join(directory, "b"), join(directory, "c")];
    await Promise.all(dirs.map((dir) => mkdir(dir, { recursive: true })));
    const identities = await Promise.all(dirs.map((dir) => loadOrCreateNodeIdentity(dir)));
    assert.equal(identities.length, 3);
    const a = identities[0]!;
    const b = identities[1]!;
    const c = identities[2]!;
    const now = 1_800_000_000_000;
    const bodySha256 = sha256Hex(Buffer.from(canonicalJson({ block: 3 }), "utf8"));
    const authenticator = new PeerRequestAuthenticator(
      [a.publicKey, b.publicKey, c.publicKey],
      chain,
      4,
      2
    );
    const signed = (identity: typeof a, nonceByte: string, timestampMs = now) => signPeerRequest(identity, {
      ...chain,
      ...request,
      bodySha256,
      timestampMs,
      nonce: nonceByte.repeat(16)
    });

    assert.equal(authenticator.verify(signed(a, "11"), { ...request, bodySha256 }, now), a.nodeId);
    assert.equal(authenticator.verify(signed(a, "22"), { ...request, bodySha256 }, now), a.nodeId);

    assert.throws(
      () => authenticator.preflight(signed(a, "33"), request, now),
      /per-identity capacity exceeded/
    );
    assert.throws(
      () => authenticator.verify(signed(a, "33"), { ...request, bodySha256 }, now),
      /per-identity capacity exceeded/
    );

    assert.equal(authenticator.verify(signed(b, "44"), { ...request, bodySha256 }, now), b.nodeId);
    assert.equal(authenticator.verify(signed(b, "55"), { ...request, bodySha256 }, now), b.nodeId);

    assert.throws(
      () => authenticator.verify(signed(c, "66"), { ...request, bodySha256 }, now),
      /replay cache capacity exceeded/
    );

    const afterExpiry = now + 60_001;
    assert.equal(
      authenticator.verify(signed(a, "77", afterExpiry), { ...request, bodySha256 }, afterExpiry),
      a.nodeId
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("per-identity replay capacity must be positive and within global and production bounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-replay-isolation-config-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    assert.throws(
      () => new PeerRequestAuthenticator([identity.publicKey], chain, 4, 0),
      /Invalid peer request per-identity replay cache capacity/
    );
    assert.throws(
      () => new PeerRequestAuthenticator([identity.publicKey], chain, 4, 5),
      /Invalid peer request per-identity replay cache capacity/
    );
    assert.throws(
      () => new PeerRequestAuthenticator([identity.publicKey], chain, 10_000, 2_501),
      /Invalid peer request per-identity replay cache capacity/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
