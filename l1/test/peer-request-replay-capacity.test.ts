import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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

test("peer request replay cache fails closed at capacity without evicting unexpired nonces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-replay-capacity-"));
  const secondDirectory = await mkdtemp(join(tmpdir(), "zyron-peer-replay-capacity-second-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const secondIdentity = await loadOrCreateNodeIdentity(secondDirectory);
    const now = 1_800_000_000_000;
    const bodySha256 = sha256Hex(Buffer.from(canonicalJson({ block: 1 }), "utf8"));
    const authenticator = new PeerRequestAuthenticator(
      [identity.publicKey, secondIdentity.publicKey],
      chain,
      2,
      2
    );
    const signed = (nonceByte: string, timestampMs = now) => signPeerRequest(identity, {
      ...chain,
      ...request,
      bodySha256,
      timestampMs,
      nonce: nonceByte.repeat(16)
    });
    const signedBySecond = (nonceByte: string, timestampMs = now) => signPeerRequest(secondIdentity, {
      ...chain,
      ...request,
      bodySha256,
      timestampMs,
      nonce: nonceByte.repeat(16)
    });

    const first = signed("11");
    const second = signed("22");
    const overflow = signedBySecond("33");

    assert.equal(authenticator.verify(first, { ...request, bodySha256 }, now), identity.nodeId);
    assert.equal(authenticator.verify(second, { ...request, bodySha256 }, now), identity.nodeId);

    assert.throws(
      () => authenticator.preflight(overflow, request, now),
      /replay cache capacity exceeded/
    );
    assert.throws(
      () => authenticator.verify(overflow, { ...request, bodySha256 }, now),
      /replay cache capacity exceeded/
    );

    assert.throws(
      () => authenticator.verify(first, { ...request, bodySha256 }, now),
      /Replayed peer request/
    );

    const afterExpiry = now + 60_001;
    const fresh = signed("44", afterExpiry);
    assert.equal(
      authenticator.verify(fresh, { ...request, bodySha256 }, afterExpiry),
      identity.nodeId
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(secondDirectory, { recursive: true, force: true });
  }
});

test("peer request replay cache amortizes expiry sweeps across consumed and reserved nonces", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-replay-sweep-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const now = 1_800_000_000_000;
    const bodySha256 = sha256Hex(Buffer.from(canonicalJson({ block: 2 }), "utf8"));
    const authenticator = new PeerRequestAuthenticator([identity.publicKey], chain, 4);
    const signed = (nonceByte: string, timestampMs: number) => signPeerRequest(identity, {
      ...chain,
      ...request,
      bodySha256,
      timestampMs,
      nonce: nonceByte.repeat(16)
    });

    assert.equal(
      authenticator.verify(signed("11", now), { ...request, bodySha256 }, now),
      identity.nodeId
    );
    const reserved = signed("22", now);
    assert.doesNotThrow(() => authenticator.preflight(reserved, request, now));
    assert.deepEqual(authenticator.replayCacheMetrics(), {
      entries: 2,
      sweepCount: 0,
      nextSweepAtMs: now + 60_001
    });

    for (let offset = 1; offset <= 20; offset += 1) {
      assert.throws(
        () => authenticator.preflight(reserved, request, now + offset),
        /Replayed peer request/
      );
    }
    assert.equal(authenticator.replayCacheMetrics().sweepCount, 0);
    assert.equal(authenticator.replayCacheMetrics().entries, 2);

    const expiryBoundary = now + 60_001;
    assert.doesNotThrow(() => authenticator.preflight(signed("33", expiryBoundary), request, expiryBoundary));
    assert.deepEqual(authenticator.replayCacheMetrics(), {
      entries: 1,
      sweepCount: 1,
      nextSweepAtMs: expiryBoundary + 60_001
    });

    assert.equal(
      authenticator.verify(signed("33", expiryBoundary), { ...request, bodySha256 }, expiryBoundary),
      identity.nodeId
    );
    assert.equal(authenticator.replayCacheMetrics().entries, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer request replay cache test capacity cannot exceed the production bound", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-replay-cap-config-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    assert.throws(
      () => new PeerRequestAuthenticator([identity.publicKey], chain, 10_001),
      /Invalid peer request replay cache capacity/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
