import assert from "node:assert/strict";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  createProtocolUpgrade,
  createProtocolUpgradeApproval
} from "../src/transaction.js";
import type { GenesisConfig } from "../src/types.js";

const validatorPrivate = "21".padStart(64, "0");
const oraclePrivate = "22".padStart(64, "0");
const poolPrivate = "23".padStart(64, "0");

const validatorPublic = publicKeyFromPrivate(validatorPrivate);
const oraclePublic = publicKeyFromPrivate(oraclePrivate);
const poolPublic = publicKeyFromPrivate(poolPrivate);
const validator = addressFromPublicKey(validatorPublic);
const pool = addressFromPublicKey(poolPublic);

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-upgrade-checkpoint-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [oraclePublic],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 0 }]
  };
}

function trustedAnchor(snapshot: ReturnType<ZyronChain["snapshot"]>) {
  return {
    tipHash: snapshot.tip.hash,
    snapshotSha256: sha256Hex(canonicalJson(snapshot))
  };
}

test("checkpoint restore preserves a future unsupported protocol schedule until activation", () => {
  const config = genesis();
  const chain = new ZyronChain(config);
  const upgradeInput = {
    chainId: config.chainId,
    nonce: 1,
    sender: validator,
    activationHeight: 101,
    protocolVersion: 4
  };
  const upgrade = createProtocolUpgrade({
    ...upgradeInput,
    approvals: [createProtocolUpgradeApproval(upgradeInput, validatorPrivate, validatorPublic)],
    timestampMs: config.timestampMs + 1
  }, validatorPrivate, validatorPublic);

  let block = chain.produceBlock([upgrade], validatorPrivate, { timestampMs: config.timestampMs + 1_000 });
  block = chain.attestBlock(block, validatorPrivate);
  chain.acceptBlock(block, config.timestampMs + 1_000);

  const snapshot = chain.snapshot();
  assert.deepEqual(snapshot.protocolSchedule, [
    { activationHeight: 0, protocolVersion: 1 },
    { activationHeight: 101, protocolVersion: 4 }
  ]);

  const restored = ZyronChain.fromTrustedSnapshot(config, snapshot, trustedAnchor(snapshot));
  assert.equal(restored.height, 1);
  assert.equal(restored.protocolVersionAt(100), 1);
  assert.equal(restored.protocolVersionAt(101), 4);
});

test("checkpoint protocol schedules still reject invalid protocol version numbers", () => {
  const config = genesis();
  const chain = new ZyronChain(config);
  const snapshot = chain.snapshot();
  snapshot.protocolSchedule.push({ activationHeight: 101, protocolVersion: 0 });

  assert.throws(
    () => ZyronChain.fromTrustedSnapshot(config, snapshot, trustedAnchor(snapshot)),
    /Invalid checkpoint protocol schedule/
  );

  snapshot.protocolSchedule[1]!.protocolVersion = 65_536;
  assert.throws(
    () => ZyronChain.fromTrustedSnapshot(config, snapshot, trustedAnchor(snapshot)),
    /Invalid checkpoint protocol schedule/
  );
});
