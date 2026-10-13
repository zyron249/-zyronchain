// Round-4 independent retest (PR974, Medium): a legacy block proposal or
// attestation carries no round, so the reference remote signer left no journal
// row and later signed a protocol v6 prepare at the same height (also after a
// restart). The signer must persist a height marker before releasing a legacy
// signature and refuse every v6 action at that height afterwards.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ReferenceRemoteSigner } from "../src/remote-signer-service.js";
import { SigningJournal } from "../src/storage.js";
import type { Validator } from "../src/types.js";
import { validatorSigningDomain, type ValidatorSigningIntent } from "../src/validator-signer.js";

const CHAIN = "zyron-remote-signer-legacy-marker";
const H = 5;
const A = "aa".repeat(32);
const B = "bb".repeat(32);
const keys: string[] = [1, 2, 3, 4].map((n) => n.toString(16).padStart(64, "0"));
const VALIDATORS: Validator[] = keys.map((k) => {
  const publicKey = publicKeyFromPrivate(k);
  return { address: addressFromPublicKey(publicKey), publicKey };
});
const req = (intent: ValidatorSigningIntent, payload: unknown, context?: unknown) =>
  ({ version: 2, intent, domain: validatorSigningDomain(intent), payload, ...(context === undefined ? {} : { context }) });
const prepare = (round: number, hash: string, height = H) =>
  req("prepare-vote", votePayload(CHAIN, height, round, hash), { justify: null });
const header = (height = H) => ({
  version: 5, chainId: CHAIN, height, round: 0, previousHash: A, timestampMs: 1700000000000,
  transactionRoot: A, stateRoot: A, proposer: VALIDATORS[0]!.address
});

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-legacy-marker-"));
  const options = { privateKey: keys[0]!, chainId: CHAIN, dataDir, allowConsensusV6Intents: true, validators: VALIDATORS };
  let signer = await ReferenceRemoteSigner.open(options);
  t.after(async () => { signer.close(); await rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir,
    get signer() { return signer; },
    async restart() { signer.close(); signer = await ReferenceRemoteSigner.open(options); }
  };
}

for (const intent of ["block-proposal", "block-attestation"] as const) {
  for (const restart of [false, true]) {
    test(`legacy ${intent} at a height refuses a v6 prepare at that height (restart=${restart})`, async (t) => {
      const f = await fixture(t);
      const payload = intent === "block-proposal" ? header() : { chainId: CHAIN, height: H, blockHash: A };
      await f.signer.sign(req(intent, payload));
      if (restart) await f.restart();
      await assert.rejects(f.signer.sign(prepare(0, B)), /legacy/i);
      // Other heights are unaffected.
      await f.signer.sign(prepare(0, B, H + 1));
    });
  }
}

test("legacy height marker is written once, survives compaction above it and is pruned at finality", async (t) => {
  const f = await fixture(t);
  await f.signer.sign(req("block-attestation", { chainId: CHAIN, height: H, blockHash: A }));
  await f.signer.sign(req("block-attestation", { chainId: CHAIN, height: H, blockHash: A }));
  const rows = (await readFile(join(f.dataDir, "signing-journal.ndjson"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(rows, [{ height: H, kind: "legacy" }]);
  f.signer.close();
  const journal = await SigningJournal.open(f.dataDir);
  try {
    await journal.reserveV6(H + 2, 0, "timeout", A).catch(() => undefined);
    await journal.compactThrough(H - 1);
    assert.equal(journal.hasLegacyRows(H), true);
    await journal.compactThrough(H);
    assert.equal(journal.hasLegacyRows(H), false);
  } finally {
    journal.close();
  }
  await f.restart();
  // Finalized height: marker pruned, nothing left to compare against.
  assert.equal((await readFile(join(f.dataDir, "signing-journal.ndjson"), "utf8")).includes('"legacy"'), false);
});

test("a v6 row at a height refuses a later legacy proposal there", async (t) => {
  const f = await fixture(t);
  await f.signer.sign(prepare(0, B));
  await assert.rejects(f.signer.sign(req("block-proposal", header())), /protocol v6/);
});

test("corrupt legacy marker rows fail closed on replay", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zyron-legacy-marker-bad-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { writeFile } = await import("node:fs/promises");
  for (const row of [{ height: 0, kind: "legacy" }, { height: H, kind: "legacy", round: 0 }]) {
    await writeFile(join(dataDir, "signing-journal.ndjson"), `${JSON.stringify(row)}\n`);
    await assert.rejects(SigningJournal.open(dataDir), /Corrupt signing journal/);
  }
});
