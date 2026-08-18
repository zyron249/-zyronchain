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

test("authenticated preflight reserves the nonce before body admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-preflight-reservation-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const now = 1_800_000_000_000;
    const bodySha256 = sha256Hex(Buffer.from(canonicalJson({ block: 7 }), "utf8"));
    const headers = signPeerRequest(identity, {
      ...chain,
      ...request,
      bodySha256,
      timestampMs: now,
      nonce: "11".repeat(16)
    });
    const authenticator = new PeerRequestAuthenticator([identity.publicKey], chain, 4, 4);

    assert.doesNotThrow(() => authenticator.preflight(headers, request, now));
    assert.equal(authenticator.replayCacheMetrics().entries, 1);
    assert.throws(() => authenticator.preflight(headers, request, now), /Replayed peer request/);

    assert.equal(
      authenticator.verify(headers, { ...request, bodySha256 }, now),
      identity.nodeId
    );
    assert.throws(
      () => authenticator.verify(headers, { ...request, bodySha256 }, now),
      /Replayed peer request/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("abandoned preflight reservation remains fail-closed until replay expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-preflight-abandoned-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const now = 1_800_000_000_000;
    const bodySha256 = sha256Hex(Buffer.from(canonicalJson({ block: 8 }), "utf8"));
    const signed = (nonceByte: string, timestampMs: number) => signPeerRequest(identity, {
      ...chain,
      ...request,
      bodySha256,
      timestampMs,
      nonce: nonceByte.repeat(16)
    });
    const authenticator = new PeerRequestAuthenticator([identity.publicKey], chain, 1, 1);
    const abandoned = signed("22", now);

    assert.doesNotThrow(() => authenticator.preflight(abandoned, request, now));
    assert.throws(
      () => authenticator.preflight(signed("33", now), request, now),
      /per-identity capacity exceeded/
    );

    const afterExpiry = now + 60_001;
    const fresh = signed("44", afterExpiry);
    assert.doesNotThrow(() => authenticator.preflight(fresh, request, afterExpiry));
    assert.equal(
      authenticator.verify(fresh, { ...request, bodySha256 }, afterExpiry),
      identity.nodeId
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
