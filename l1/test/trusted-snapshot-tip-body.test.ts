import assert from "node:assert/strict";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createStateV2PortableBundle } from "../src/state-v2-portable.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } from "../src/transaction.js";
import type { Block, GenesisConfig, Transaction } from "../src/types.js";

// A trusted checkpoint pins (tipHash, snapshotSha256). The tip header is
// authenticated by its hash and finality certificate, but the tip body must be
// bound to header.transactionRoot as well: otherwise whoever produces the pinned
// digest can ship a certified header with a different body, which the node
// would then store and serve as its tip.

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 0x51, ORACLE = 0x52, POOL = 0x53, SENDER = 0x54, RECEIVER = 0x55;

function genesis(): GenesisConfig {
  return {
    chainId: "zyron-tip-body-1",
    timestampMs: 1_700_000_000_000,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(POOL),
    allocations: [
      { address: addr(POOL), amountAtoms: 0 },
      { address: addr(SENDER), amountAtoms: 1_000_000_000 }
    ]
  };
}

function finalize(chain: ZyronChain, transactions: Transaction[], timestampMs: number): Block {
  let block = chain.produceBlock(transactions, key(VALIDATOR), { timestampMs });
  if (isConsensusV6(block.header.version)) {
    block.commitRound = 0;
    block.attestations = [{
      validator: addr(VALIDATOR),
      publicKey: pub(VALIDATOR),
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
    }];
  } else {
    block = chain.attestBlock(block, key(VALIDATOR));
  }
  chain.acceptBlock(block, timestampMs);
  return block;
}

function chainAt(version: number): { config: GenesisConfig; chain: ZyronChain } {
  const config = genesis();
  const chain = new ZyronChain(config);
  if (version > 1) {
    const input = { chainId: config.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
    const upgrade = createProtocolUpgrade({
      ...input,
      approvals: [createProtocolUpgradeApproval(input, key(VALIDATOR), pub(VALIDATOR))],
      timestampMs: config.timestampMs + 1
    }, key(VALIDATOR), pub(VALIDATOR));
    for (let height = 1; height <= 100; height += 1) {
      finalize(chain, height === 1 ? [upgrade] : [], config.timestampMs + height * 1_000);
    }
  }
  assert.equal(chain.protocolVersionAt(chain.height + 1), version);
  return { config, chain };
}

function transfer(config: GenesisConfig, version: number, nonce: number, amountAtoms: number): Transaction {
  return createTransfer({
    chainId: config.chainId,
    sender: addr(SENDER),
    receiver: addr(RECEIVER),
    nonce,
    amountAtoms,
    feeAtoms: 10,
    timestampMs: config.timestampMs + 1
  }, key(SENDER), pub(SENDER), version >= 3 ? 2 : 1);
}

const anchor = (snapshot: unknown, tipHash: string) => ({ tipHash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) });

// v4 is not a supported protocol version.
for (const version of [1, 2, 3, 5, 6]) {
  test(`v${version}: trusted snapshot rejects a certified tip whose body does not match transactionRoot`, () => {
    const { config, chain } = chainAt(version);
    const tip = finalize(chain, [transfer(config, version, 1, 1_000)], config.timestampMs + 200_000);
    assert.equal(tip.header.version, version);
    assert.equal(tip.transactions.length, 1);
    const snapshot = chain.snapshot();

    const tamperings: Array<[string, (block: Block) => void]> = [
      ["emptied body", (block) => { block.transactions = []; }],
      ["substituted transaction", (block) => { block.transactions = [transfer(config, version, 1, 2_000)]; }],
      ["appended transaction", (block) => { block.transactions.push(transfer(config, version, 2, 1)); }]
    ];
    for (const [name, mutate] of tamperings) {
      const tampered = structuredClone(snapshot);
      mutate(tampered.tip);
      // The attacker controls the pinned digest; the header (hash, certificate) is untouched.
      assert.equal(tampered.tip.hash, snapshot.tip.hash);
      assert.throws(
        () => ZyronChain.fromTrustedSnapshot(config, tampered, anchor(tampered, tampered.tip.hash)),
        /Trusted checkpoint tip transaction root mismatch/,
        `${name} must be rejected`
      );
    }
  });
}

for (const version of [1, 2, 3, 5]) {
  test(`v${version}: untampered trusted snapshot with a non-empty tip body is still accepted`, () => {
    const { config, chain } = chainAt(version);
    finalize(chain, [transfer(config, version, 1, 1_000)], config.timestampMs + 200_000);
    const snapshot = chain.snapshot();
    const restored = ZyronChain.fromTrustedSnapshot(config, snapshot, anchor(snapshot, snapshot.tip.hash));
    assert.equal(restored.tip.hash, chain.tip.hash);
    assert.deepEqual(restored.tip.transactions, chain.tip.transactions);
    assert.equal(restored.balance(addr(RECEIVER)), 1_000);
  });
}

for (const version of [5, 6]) {
  test(`v${version}: portable State-v2 checkpoint rejects a tip whose body does not match transactionRoot`, () => {
    const { config, chain } = chainAt(version);
    finalize(chain, [transfer(config, version, 1, 1_000)], config.timestampMs + 200_000);
    const snapshot = chain.snapshot();
    const bundle = createStateV2PortableBundle(chain.stateV2ForPersistence()!, snapshot.state, {
      validatorSchedule: snapshot.validatorSchedule,
      protocolSchedule: snapshot.protocolSchedule
    });
    const tip = structuredClone(snapshot.tip);
    tip.transactions = [];
    const rebuilt = { ...structuredClone(snapshot), tip };
    assert.throws(
      () => ZyronChain.fromTrustedPortableState(config, tip, bundle, anchor(rebuilt, tip.hash)),
      /Trusted checkpoint tip transaction root mismatch/
    );
  });
}

// merkleRoot duplicates the last leaf of an odd level, so [a, b, c] and
// [a, b, c, c] share a root (the CVE-2012-2459 shape). Live block validation
// rejects the duplicate in applyTransactions, but the snapshot path does not
// re-execute the tip, so it must reject duplicate transactions explicitly.
for (const version of [1, 2, 3, 5, 6]) {
  test(`v${version}: trusted snapshot rejects a tip body with a duplicated odd tail (same Merkle root)`, () => {
    const { config, chain } = chainAt(version);
    finalize(chain, [
      transfer(config, version, 1, 1),
      transfer(config, version, 2, 2),
      transfer(config, version, 3, 3)
    ], config.timestampMs + 200_000);
    const snapshot = chain.snapshot();
    const tampered = structuredClone(snapshot);
    tampered.tip.transactions.push(structuredClone(tampered.tip.transactions[2]!));
    assert.throws(
      () => ZyronChain.fromTrustedSnapshot(config, tampered, anchor(tampered, tampered.tip.hash)),
      /Trusted checkpoint tip contains a duplicate transaction/
    );
  });
}
