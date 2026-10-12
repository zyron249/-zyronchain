// P0-09: the reference remote signer must enforce the protocol v6 journal
// rules itself (F01 design §4 locking, §6 anti-equivocation, §9 persistence),
// so a compromised or buggy node cannot obtain a double-sign or a lock
// violation from the custody boundary. v6 intents stay refused unless the
// operator enables them explicitly.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { blockHash, roundSkipPayload } from "../src/block.js";
import {
  proposalPayload,
  signV6,
  timeoutPayload,
  V6_PREPARE_VOTE_DOMAIN,
  votePayload,
  ZERO_HASH,
  type PrepareQC
} from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate, verifyCanonicalDomain } from "../src/crypto.js";
import { ReferenceRemoteSigner, startReferenceRemoteSignerServer } from "../src/remote-signer-service.js";
import type { BlockHeader, Validator } from "../src/types.js";
import { RemoteValidatorSigner, validatorSigningDomain, type ValidatorSigningIntent } from "../src/validator-signer.js";

const CHAIN = "zyron-remote-signer-v6";
const key = (n: number) => (0x70 + n).toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
// n = 4, q = 3. The signer holds validator 0's key.
const VALIDATORS: Validator[] = [0, 1, 2, 3].map((n) => ({ address: addr(n), publicKey: pub(n) }));
// expectedValidator(H = 5, r) = VALIDATORS[r % 4]: the signer leads round 0 (and 4, 8, ...).
const H = 5;
const B = "b1".repeat(32);
const B2 = "b2".repeat(32);
const TOKEN = "reference-remote-signer-test-token-0123456789";

function qc(round: number, blockHashValue: string, signers = [1, 2, 3], height = H): PrepareQC {
  return {
    chainId: CHAIN,
    height,
    round,
    blockHash: blockHashValue,
    votes: signers.map((n) => ({
      validator: addr(n),
      publicKey: pub(n),
      signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(CHAIN, height, round, blockHashValue), key(n))
    }))
  };
}

function request(intent: ValidatorSigningIntent, payload: unknown, context?: unknown) {
  return { version: 2, intent, domain: validatorSigningDomain(intent), payload, ...(context === undefined ? {} : { context }) };
}

const prepare = (round: number, hash: string, justify: PrepareQC | null = null, height = H) =>
  request("prepare-vote", votePayload(CHAIN, height, round, hash), { justify });
const commit = (round: number, hash: string, certificate: PrepareQC | null = qc(round, hash), height = H) =>
  request("commit-vote", votePayload(CHAIN, height, round, hash), { qc: certificate });
function timeout(round: number, highQC: PrepareQC | null = null, height = H) {
  return request("round-timeout", timeoutPayload({
    chainId: CHAIN, height, round, highQCRound: highQC?.round ?? -1, highQCHash: highQC?.blockHash ?? ZERO_HASH
  }), { highQC });
}
const proposal = (round: number, hash: string, justify: PrepareQC | null = null) =>
  request("consensus-proposal", proposalPayload({ chainId: CHAIN, height: H, round, blockHash: hash, justifyRound: justify?.round ?? -1 }), { justify });

function header(round: number, seed: string, version = 6): BlockHeader {
  return {
    version, chainId: CHAIN, height: H, round, previousHash: "aa".repeat(32), timestampMs: 1_700_000_000_000 + round,
    transactionRoot: seed.repeat(32), stateRoot: "cc".repeat(32), proposer: addr(0)
  };
}

async function withSigner(
  run: (open: (enableV6?: boolean) => Promise<ReferenceRemoteSigner>) => Promise<void>
): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-remote-signer-v6-"));
  const opened: ReferenceRemoteSigner[] = [];
  try {
    await run(async (enableV6 = true) => {
      const signer = await ReferenceRemoteSigner.open({
        privateKey: key(0),
        dataDir,
        chainId: CHAIN,
        ...(enableV6 ? { allowConsensusV6Intents: true, validators: VALIDATORS } : {})
      });
      opened.push(signer);
      return signer;
    });
  } finally {
    for (const signer of opened) signer.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

/** Close and reopen from the same data directory (process restart). */
async function restart(signer: ReferenceRemoteSigner, open: () => Promise<ReferenceRemoteSigner>): Promise<ReferenceRemoteSigner> {
  signer.close();
  return open();
}

const REFUSED = /refused|Conflicting|not enabled|lock|timed out|later round|leader|fresh block|Prepare QC|evidence/i;

test("v6 intents are refused by default; legacy intents still sign", async () => {
  await withSigner(async (open) => {
    const signer = await open(false);
    for (const req of [prepare(0, B), commit(0, B), timeout(0), proposal(0, B), request("block-proposal", header(0, "01"))]) {
      await assert.rejects(() => signer.sign(req), /not enabled for protocol v6/);
    }
    const legacyHeader = header(0, "02", 5);
    const signed = await signer.sign(request("block-proposal", legacyHeader));
    assert.ok(verifyCanonicalDomain(validatorSigningDomain("block-proposal"), legacyHeader, signed.signature, pub(0)));
  });
});

test("enabling v6 requires the validator set used to verify certificates", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-remote-signer-v6-cfg-"));
  try {
    await assert.rejects(
      () => ReferenceRemoteSigner.open({ privateKey: key(0), dataDir, chainId: CHAIN, allowConsensusV6Intents: true }),
      /validator set/
    );
    await assert.rejects(
      () => ReferenceRemoteSigner.open({
        privateKey: key(0), dataDir, chainId: CHAIN, allowConsensusV6Intents: true,
        validators: VALIDATORS.slice(1)
      }),
      /not a member/
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("requests for another chain, a wrong domain or with extra fields are refused", async () => {
  await withSigner(async (open) => {
    const signer = await open();
    await assert.rejects(() => signer.sign(request("prepare-vote", votePayload("zyron-other", H, 0, B), { justify: null })), /chain/i);
    await assert.rejects(() => signer.sign({ ...prepare(0, B), domain: validatorSigningDomain("commit-vote") }), /domain/i);
    await assert.rejects(() => signer.sign({ ...prepare(0, B), extra: true }), /unexpected|keys|Invalid/i);
    await assert.rejects(() => signer.sign({ version: 1, intent: "prepare-vote", payload: votePayload(CHAIN, H, 0, B) }), /version/i);
  });
});

test("prepare: one block per (height, round), idempotent re-sign, refused across restart", async () => {
  await withSigner(async (open) => {
    let signer = await open();
    const first = await signer.sign(prepare(0, B));
    assert.ok(verifyCanonicalDomain(V6_PREPARE_VOTE_DOMAIN, votePayload(CHAIN, H, 0, B), first.signature, pub(0)));
    assert.deepEqual(await signer.sign(prepare(0, B)), first);
    await assert.rejects(() => signer.sign(prepare(0, B2)), REFUSED);
    signer = await restart(signer, open);
    await assert.rejects(() => signer.sign(prepare(0, B2)), REFUSED, "double prepare after restart");
    assert.deepEqual(await signer.sign(prepare(0, B)), first);
  });
});

test("commit: requires a valid PrepareQC for exactly (height, round, block)", async () => {
  await withSigner(async (open) => {
    const signer = await open();
    await assert.rejects(() => signer.sign(commit(0, B, null)), REFUSED);
    await assert.rejects(() => signer.sign(commit(0, B, qc(0, B, [1, 2]))), /quorum/);
    await assert.rejects(() => signer.sign(commit(0, B, qc(0, B2))), REFUSED);
    await assert.rejects(() => signer.sign(commit(0, B, qc(1, B))), REFUSED);
    const forged = qc(0, B);
    forged.votes[0]!.signature = signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(CHAIN, H, 0, B2), key(1));
    await assert.rejects(() => signer.sign(commit(0, B, forged)), /signature/i);
    const outsider = qc(0, B, [1, 2]);
    outsider.votes.push({
      validator: addressFromPublicKey(publicKeyFromPrivate(key(9))),
      publicKey: publicKeyFromPrivate(key(9)),
      signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(CHAIN, H, 0, B), key(9))
    });
    await assert.rejects(() => signer.sign(commit(0, B, outsider)), /Unknown/);
    await signer.sign(commit(0, B));
  });
});

test("commit after a prepare for another block in the same round is refused, also after restart", async () => {
  await withSigner(async (open) => {
    let signer = await open();
    await signer.sign(prepare(0, B));
    // A real QC for B2 can exist without this validator (n = 4, q = 3).
    await assert.rejects(() => signer.sign(commit(0, B2)), REFUSED);
    signer = await restart(signer, open);
    await assert.rejects(() => signer.sign(commit(0, B2)), REFUSED);
    await signer.sign(commit(0, B));
    await assert.rejects(() => signer.sign(commit(0, B2)), REFUSED, "double commit");
  });
});

test("lock rule: a lock is released only by a verified higher-round PrepareQC, and survives restart", async () => {
  await withSigner(async (open) => {
    let signer = await open();
    await signer.sign(commit(0, B)); // lock = (0, B)
    signer = await restart(signer, open);
    // Unjustified proposal for another block at a later round.
    await assert.rejects(() => signer.sign(prepare(1, B2)), REFUSED);
    // Justify at the lock round does not unlock (needs justifyRound > lock.round).
    await assert.rejects(() => signer.sign(prepare(1, B2, qc(0, B2))), REFUSED);
    // Justify for a different block than the one being voted does not count.
    await assert.rejects(() => signer.sign(prepare(2, B2, qc(1, B))), REFUSED);
    // A forged or under-quorum higher QC does not unlock.
    await assert.rejects(() => signer.sign(prepare(2, B2, qc(1, B2, [1, 2]))), /quorum/);
    // The locked block itself stays votable without evidence.
    await signer.sign(prepare(1, B));
    // A valid PrepareQC(H, 1, B2) with lock.round < 1 < 2 unlocks for round 2.
    signer = await restart(signer, open);
    await signer.sign(prepare(2, B2, qc(1, B2)));
    // Lock moves forward only via commit with a QC at a higher round.
    await signer.sign(commit(2, B2, qc(2, B2)));
    signer = await restart(signer, open);
    await assert.rejects(() => signer.sign(commit(1, B, qc(1, B))), REFUSED, "lock may not move backwards");
  });
});

test("timeout: legal after a vote in the round, closes the round, one payload per round, survives restart", async () => {
  await withSigner(async (open) => {
    let signer = await open();
    await signer.sign(prepare(0, B));
    const first = await signer.sign(timeout(0));
    assert.deepEqual(await signer.sign(timeout(0)), first, "identical payload re-signs identically");
    await assert.rejects(() => signer.sign(timeout(0, qc(0, B))), REFUSED, "different payload for the same round");
    await assert.rejects(() => signer.sign(commit(0, B)), REFUSED, "commit after timeout in the same round");
    await assert.rejects(() => signer.sign(prepare(0, B2)), REFUSED);
    signer = await restart(signer, open);
    await assert.rejects(() => signer.sign(timeout(0, qc(0, B))), REFUSED);
    await assert.rejects(() => signer.sign(commit(0, B)), REFUSED);
    assert.deepEqual(await signer.sign(timeout(0)), first);
    // A vote at round 2 closes every lower round for a new timeout.
    await signer.sign(prepare(2, B));
    await assert.rejects(() => signer.sign(timeout(1)), REFUSED);
  });
});

test("timeout: the reported highQC must be a verified QC with -1 <= highQCRound <= round", async () => {
  await withSigner(async (open) => {
    const signer = await open();
    await assert.rejects(() => signer.sign(timeout(0, qc(1, B))), /highQC|round/i);
    const fake = request("round-timeout", timeoutPayload({ chainId: CHAIN, height: H, round: 1, highQCRound: 0, highQCHash: B }), { highQC: null });
    await assert.rejects(() => signer.sign(fake), /highQC/i);
    await assert.rejects(() => signer.sign(timeout(1, qc(0, B, [1, 2]))), /quorum/);
    await signer.sign(commit(1, B, qc(1, B)));
    // After a lock at round 1, timeout(1) is still legal and may report the round-1 QC.
    await signer.sign(timeout(1, qc(1, B)));
  });
});

test("proposals: only the round leader, unjustified only for its own fresh block, one per round", async () => {
  await withSigner(async (open) => {
    let signer = await open();
    // Round 1 is led by validator 1.
    await assert.rejects(() => signer.sign(request("block-proposal", { ...header(1, "03"), proposer: addr(0) })), /leader|proposer/i);
    await assert.rejects(() => signer.sign(proposal(1, B)), /leader/i);
    // Round 0: an unjustified proposal must carry the signer's own fresh block of that round.
    const fresh = header(0, "04");
    const freshHash = blockHash(fresh);
    await assert.rejects(() => signer.sign(proposal(0, freshHash)), /fresh block/i);
    await signer.sign(request("block-proposal", fresh));
    await assert.rejects(() => signer.sign(request("block-proposal", header(0, "05"))), REFUSED, "second fresh block in a round");
    signer = await restart(signer, open);
    await assert.rejects(() => signer.sign(request("block-proposal", header(0, "05"))), REFUSED, "after restart");
    const signed = await signer.sign(proposal(0, freshHash));
    assert.deepEqual(await signer.sign(proposal(0, freshHash)), signed);
    await assert.rejects(() => signer.sign(proposal(0, B2, null)), REFUSED);
    // Round 4 (signer leads again): a justified re-proposal needs the verified QC.
    await assert.rejects(() => signer.sign(request("consensus-proposal", proposalPayload({
      chainId: CHAIN, height: H, round: 4, blockHash: B, justifyRound: 3
    }), { justify: null })), /justify/i);
    await signer.sign(proposal(4, B, qc(3, B)));
  });
});

test("legacy and v6 signatures never mix at one height", async () => {
  await withSigner(async (open) => {
    const signer = await open();
    await signer.sign(prepare(0, B));
    const skip = roundSkipPayload({ validator: addr(0), publicKey: pub(0), chainId: CHAIN, height: H, round: 1, previousHash: "aa".repeat(32) });
    await assert.rejects(() => signer.sign(request("round-skip", skip)), /v6|legacy/i);
    await assert.rejects(() => signer.sign(request("block-attestation", { chainId: CHAIN, height: H, blockHash: B })), /v6|legacy/i);
    const otherHeight = roundSkipPayload({ validator: addr(0), publicKey: pub(0), chainId: CHAIN, height: H + 1, round: 0, previousHash: "aa".repeat(32) });
    await signer.sign(request("round-skip", otherHeight));
    await assert.rejects(() => signer.sign(prepare(0, B, null, H + 1)), /legacy/i);
  });
});

test("two signer processes cannot share one journal", async () => {
  await withSigner(async (open) => {
    await open();
    await assert.rejects(() => open(), /lock|lease|busy|already/i);
  });
});

test("HTTP: authenticated client signs through the reference signer; conflicts and bad tokens fail", async () => {
  await withSigner(async (open) => {
    const signer = await open();
    const server = await startReferenceRemoteSignerServer({ signer, host: "127.0.0.1", port: 0, bearerToken: TOKEN });
    try {
      const client = new RemoteValidatorSigner(server.url, pub(0), TOKEN, 3_000, { allowConsensusV6Intents: true });
      const signature = await client.signCanonical(votePayload(CHAIN, H, 0, B), "prepare-vote", 6, { justify: null });
      assert.ok(verifyCanonicalDomain(V6_PREPARE_VOTE_DOMAIN, votePayload(CHAIN, H, 0, B), signature, pub(0)));
      await assert.rejects(() => client.signCanonical(votePayload(CHAIN, H, 0, B2), "prepare-vote", 6, { justify: null }), /HTTP 409/);
      const wrongToken = new RemoteValidatorSigner(server.url, pub(0), `${TOKEN}-wrong`, 3_000, { allowConsensusV6Intents: true });
      await assert.rejects(() => wrongToken.signCanonical(votePayload(CHAIN, H, 1, B), "prepare-vote", 6, { justify: null }), /HTTP 401/);
      const committed = await client.signCanonical(votePayload(CHAIN, H, 0, B), "commit-vote", 6, { qc: qc(0, B) });
      assert.ok(committed.length === 128);
    } finally {
      await server.close();
    }
  });
});
