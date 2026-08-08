import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  createSignedPeerRecord,
  loadOrCreateNodeIdentity,
  PeerRequestAuthenticator,
  signPeerRequest,
  validateSignedPeerRecord
} from "../src/peer-identity.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";

const chain = { chainId: "zyron-devnet-1", genesisHash: "ab".repeat(32) };

test("node identity is generated once, stored privately, and stable across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-id-"));
  try {
    const first = await loadOrCreateNodeIdentity(directory);
    const second = await loadOrCreateNodeIdentity(directory);
    assert.deepEqual(second, first);
    assert.notEqual(first.nodeId, first.publicKey);
    assert.equal((await stat(join(directory, "node-identity.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("node identity fails closed when persisted key material is inconsistent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-id-corrupt-"));
  try {
    await loadOrCreateNodeIdentity(directory);
    const path = join(directory, "node-identity.json");
    const identity = JSON.parse(await readFile(path, "utf8")) as { nodeId: string };
    identity.nodeId = "00".repeat(32);
    await writeFile(path, JSON.stringify(identity), "utf8");
    await assert.rejects(() => loadOrCreateNodeIdentity(directory), /Node identity key mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("signed peer records bind identity, chain, endpoints and expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-record-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const now = 1_800_000_000_000;
    const record = createSignedPeerRecord(identity, {
      ...chain,
      endpoints: ["https://node-b.example:9137/", "https://node-a.example:9137"],
      issuedAtMs: now,
      expiresAtMs: now + 60_000
    });
    const verified = validateSignedPeerRecord(record, chain, now + 1_000);
    assert.deepEqual(verified.endpoints, ["https://node-a.example:9137", "https://node-b.example:9137"]);

    const spoofedEndpoint = structuredClone(record);
    spoofedEndpoint.endpoints[0] = "https://attacker.example:9137";
    assert.throws(() => validateSignedPeerRecord(spoofedEndpoint, chain, now + 1_000), /signature/);
    assert.throws(
      () => validateSignedPeerRecord(record, { ...chain, genesisHash: "cd".repeat(32) }, now + 1_000),
      /chain identity mismatch/
    );
    assert.throws(() => validateSignedPeerRecord(record, chain, now + 60_000), /expired/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer discovery records reject plaintext, credentials and excessive lifetime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-record-policy-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const now = 1_800_000_000_000;
    assert.throws(() => createSignedPeerRecord(identity, {
      ...chain, endpoints: [], issuedAtMs: now, expiresAtMs: now + 1_000
    }), /endpoint count/);
    assert.throws(() => createSignedPeerRecord(identity, {
      ...chain, endpoints: ["http://node.example:9137"], issuedAtMs: now, expiresAtMs: now + 1_000
    }), /HTTPS/);
    assert.throws(() => createSignedPeerRecord(identity, {
      ...chain, endpoints: ["https://user:secret@node.example:9137"], issuedAtMs: now, expiresAtMs: now + 1_000
    }), /HTTPS/);
    assert.throws(() => createSignedPeerRecord(identity, {
      ...chain, endpoints: ["https://node.example:9137"], issuedAtMs: now, expiresAtMs: now + (25 * 60 * 60 * 1_000)
    }), /validity window/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer request signatures bind identity, chain, method, path and body while rejecting replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-peer-request-"));
  try {
    const identity = await loadOrCreateNodeIdentity(directory);
    const now = 1_800_000_000_000;
    const body = canonicalJson({ height: 42, round: 1 });
    const bodySha256 = sha256Hex(Buffer.from(body, "utf8"));
    const headers = signPeerRequest(identity, {
      ...chain,
      method: "POST",
      path: "/round/skip",
      bodySha256,
      timestampMs: now,
      nonce: "11".repeat(16)
    });
    const authenticator = new PeerRequestAuthenticator([identity.publicKey], chain);
    assert.equal(authenticator.verify(headers, { method: "POST", path: "/round/skip", bodySha256 }, now), identity.nodeId);
    assert.throws(
      () => authenticator.verify(headers, { method: "POST", path: "/round/skip", bodySha256 }, now),
      /Replayed/
    );

    const fresh = signPeerRequest(identity, {
      ...chain, method: "POST", path: "/round/skip", bodySha256, timestampMs: now, nonce: "22".repeat(16)
    });
    assert.throws(
      () => new PeerRequestAuthenticator([identity.publicKey], chain)
        .verify(fresh, { method: "POST", path: "/block", bodySha256 }, now),
      /Invalid peer request signature/
    );
    assert.throws(
      () => new PeerRequestAuthenticator([identity.publicKey], chain)
        .verify(fresh, { method: "POST", path: "/round/skip", bodySha256: "00".repeat(32) }, now),
      /Invalid peer request signature/
    );
    assert.throws(
      () => new PeerRequestAuthenticator([identity.publicKey], chain)
        .verify(fresh, { method: "POST", path: "/round/skip", bodySha256 }, now + 60_001),
      /timestamp outside allowed window/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("peer request authentication rejects identities outside the explicit trust set", async () => {
  const trustedDirectory = await mkdtemp(join(tmpdir(), "zyron-peer-trusted-"));
  const strangerDirectory = await mkdtemp(join(tmpdir(), "zyron-peer-stranger-"));
  try {
    const trusted = await loadOrCreateNodeIdentity(trustedDirectory);
    const stranger = await loadOrCreateNodeIdentity(strangerDirectory);
    const now = 1_800_000_000_000;
    const bodySha256 = sha256Hex(Buffer.from(canonicalJson({ accepted: true }), "utf8"));
    const headers = signPeerRequest(stranger, {
      ...chain, method: "POST", path: "/block", bodySha256, timestampMs: now, nonce: "33".repeat(16)
    });
    assert.throws(
      () => new PeerRequestAuthenticator([trusted.publicKey], chain)
        .verify(headers, { method: "POST", path: "/block", bodySha256 }, now),
      /Untrusted peer identity/
    );
  } finally {
    await rm(trustedDirectory, { recursive: true, force: true });
    await rm(strangerDirectory, { recursive: true, force: true });
  }
});
