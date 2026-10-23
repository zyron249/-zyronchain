// P1-07-F2 (follow-up to P1-07-F1, Codex P2 on #1095): transaction gossip can
// deliver the same-block re-add `validator_update` before its pending removal
// predecessor. Admission refuses it then (fail-closed), but the node keeps a
// small, bounded set of such refused updates and re-tries them once another
// `validator_update` is admitted, so the re-add is not lost to gossip order.
// Block selection and validation are unchanged.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { expectedValidator } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { MAX_DEFERRED_VALIDATOR_UPDATES, NodeService, createRpcServer } from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createTransfer, createValidatorApproval, createValidatorSetUpdate } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type Transaction, type GenesisConfig, type Validator, type ValidatorPossessionProof, type ValidatorSetUpdateTx } from "../src/types.js";
import { signGenesisPossessionProofs, signValidatorUpdatePossessionProof } from "../src/validator-admission.js";

const ZYN = ATOMS_PER_ZYN;
const T0 = 1_700_000_000_000;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const validator = (n: number): Validator => ({ address: addr(n), publicKey: pub(n) });
const GENESIS_SET = [0x21, 0x22, 0x23, 0x24];
const MISSING = /one possession proof per incoming validator/;

function optedIn(chainId: string): GenesisConfig {
  const pool = addr(0x90);
  return signGenesisPossessionProofs({
    chainId,
    timestampMs: T0,
    validators: GENESIS_SET.map(validator),
    activityOracles: [pub(0x91)],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 1_000 * ZYN }, { address: addr(0x22), amountAtoms: 10 * ZYN }]
  }, GENESIS_SET.map(key));
}

function proof(chain: ZyronChain, activationHeight: number, id: number): ValidatorPossessionProof {
  return signValidatorUpdatePossessionProof({
    chainId: chain.genesis.chainId,
    genesisHash: chain.genesisHash,
    activationHeight,
    validator: validator(id)
  }, key(id));
}

function update(
  chain: ZyronChain,
  next: number[],
  options: { activationHeight?: number; nonce?: number; proofs?: ValidatorPossessionProof[]; signers?: number[] } = {}
): ValidatorSetUpdateTx {
  const signers = options.signers ?? GENESIS_SET.slice(0, 3);
  const sender = signers[0]!;
  const input = {
    chainId: chain.genesis.chainId,
    nonce: options.nonce ?? 1,
    sender: addr(sender),
    activationHeight: options.activationHeight ?? 150,
    validators: next.map(validator)
  };
  const approvals = signers.map((id) => createValidatorApproval(input, key(id), pub(id), 1));
  return createValidatorSetUpdate({
    ...input,
    approvals,
    timestampMs: T0 + 10,
    possessionProofs: options.proofs ?? []
  }, key(sender), pub(sender), 1);
}

async function withService(chainId: string, run: (service: NodeService, chain: ZyronChain) => Promise<void> | void): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "zyron-p107f2-"));
  try {
    const store = await ChainStore.open(optedIn(chainId), directory);
    await run(new NodeService(store), store.chain);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("P1-07-F2: a re-add gossiped before its removal is admitted once the removal arrives", async () => {
  await withService("zyron-devnet-p107f2-order", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    // Another sender's re-add (nonce 1) can arrive first over gossip.
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING, "still refused while no predecessor is pending");
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), false);
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), true, "the deferred re-add is re-tried after the removal is admitted");
    // Re-admitted updates are handed out once, for relaying to peers.
    assert.deepEqual(service.takeReadmittedTransactions().map((tx) => tx.txid), [readd.txid]);
    assert.deepEqual(service.takeReadmittedTransactions(), []);
    assert.equal(service.submitTransaction(readd), readd.txid, "re-submitting the re-admitted update still succeeds");
    assert.throws(() => service.submitTransaction(remove), /already in mempool/, "other duplicates are unchanged");
    const at = chain.tip.header.timestampMs + 1_000;
    assert.deepEqual(chain.selectValidPending(service.mempool.values(), 10, undefined, at).map((tx) => tx.txid), [remove.txid, readd.txid]);
  });
});

test("P1-07-F2: only refused validator updates are deferred, and only while they can still activate", async () => {
  await withService("zyron-devnet-p107f2-scope", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    // A transfer is never deferred.
    const transfer = createTransfer({
      chainId: chain.genesis.chainId, nonce: 1, sender: addr(0x22), receiver: addr(0x30),
      amountAtoms: 100 * ZYN, feeAtoms: 0, timestampMs: T0 + 10
    }, key(0x22), pub(0x22));
    assert.throws(() => service.submitTransaction(transfer));
    // An update without quorum stays refused after any predecessor arrives.
    const noQuorum = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23]
    });
    assert.throws(() => service.submitTransaction(noQuorum));
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.values().some((tx) => tx.txid === transfer.txid), false);
    assert.equal(service.mempool.values().some((tx) => tx.txid === noQuorum.txid), false);
    assert.deepEqual(service.takeReadmittedTransactions(), []);
    assert.equal(service.deferredValidatorUpdateCount(), 0, "a deferred update that fails again for good is dropped");
  });
});

test("P1-07-F2: the deferred set is bounded", async () => {
  await withService("zyron-devnet-p107f2-bound", (service, chain) => {
    for (let index = 0; index < MAX_DEFERRED_VALIDATOR_UPDATES + 8; index += 1) {
      const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
        activationHeight: 300 + index, nonce: 1, proofs: [proof(chain, 300 + index, 0x24)], signers: [0x22, 0x23, 0x21]
      });
      assert.throws(() => service.submitTransaction(readd), MISSING);
    }
    assert.equal(service.deferredValidatorUpdateCount(), MAX_DEFERRED_VALIDATOR_UPDATES);
  });
});

// Codex P2s on #1104 (ab04d3a).
test("P1-07-F2: unauthorized updates are not deferred and cannot evict a deferred re-add", async () => {
  await withService("zyron-devnet-p107f2-evict", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    assert.equal(service.deferredValidatorUpdateCount(), 1);
    // Shape-valid but unauthorized: signed and approved only by keys that are not active validators.
    for (let index = 0; index < MAX_DEFERRED_VALIDATOR_UPDATES + 4; index += 1) {
      const outsider = update(chain, [0x31, 0x32, 0x33, 0x34], {
        activationHeight: 400 + index, nonce: 1, signers: [0x31, 0x32, 0x33],
        proofs: [0x31, 0x32, 0x33, 0x34].map((id) => proof(chain, 400 + index, id))
      });
      assert.throws(() => service.submitTransaction(outsider), /not active|Unknown validator update approver/);
    }
    assert.equal(service.deferredValidatorUpdateCount(), 1, "unauthorized updates must not be deferred");
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), true, "the legitimate re-add survives");
  });
});

test("P1-07-F2: deferred updates are re-tried when the predecessor arrives in a finalized block", async () => {
  await withService("zyron-devnet-p107f2-finalized", async (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    // This node never sees the removal's transaction gossip, only the finalized block.
    const producer = new ZyronChain(chain.genesis);
    const timestampMs = T0 + 1_000;
    const proposer = expectedValidator(chain.genesis.validators, 1, 0);
    const proposerId = GENESIS_SET.find((id) => pub(id) === proposer.publicKey)!;
    let block = producer.produceBlock([remove], key(proposerId), { timestampMs });
    for (const id of GENESIS_SET) block = producer.attestBlock(block, key(id));
    await service.acceptFinalizedBlock(block);
    assert.equal(chain.height, 1);
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), true, "the deferred re-add is re-tried after the finalized predecessor");
  });
});

test("P1-07-F2: re-admitted updates are relayed whichever transport delivered the predecessor", async () => {
  await withService("zyron-devnet-p107f2-native", async (service, chain) => {
    const relayed: Transaction[] = [];
    const server = createRpcServer(service, { onTransactionAccepted: (tx) => { relayed.push(tx); } });
    try {
      const remove = update(chain, [0x21, 0x22, 0x23]);
      const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
        activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
      });
      assert.throws(() => service.submitTransaction(readd), MISSING);
      // The native consensus transport calls submitTransaction directly (p2p-consensus.ts).
      assert.equal(service.submitTransaction(remove), remove.txid);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(relayed.map((tx) => tx.txid), [readd.txid], "the re-admitted update is relayed once");
    } finally {
      server.close();
    }
  });
});

// Codex P2s on #1104 (83c7928).
test("P1-07-F2: proof-only variants of one approved update cannot evict another deferred re-add", async () => {
  await withService("zyron-devnet-p107f2-variants", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    // One quorum-approved update, re-signed with different (invalid) proofs:
    // the approvals do not cover possessionProofs, so every variant has its own txid.
    for (let index = 0; index < MAX_DEFERRED_VALIDATOR_UPDATES + 4; index += 1) {
      const variant = update(chain, [0x21, 0x22, 0x23, 0x24], {
        activationHeight: 400, nonce: 1, proofs: [proof(chain, 1_000 + index, 0x24)], signers: [0x23, 0x22, 0x21]
      });
      assert.throws(() => service.submitTransaction(variant));
    }
    assert.ok(service.deferredValidatorUpdateCount() < MAX_DEFERRED_VALIDATOR_UPDATES, "variants of one approved update share a bounded slot");
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), true, "the legitimate re-add survives");
  });
});

test("P1-07-F2: a re-add refused for an incomplete predecessor nonce prefix is re-tried when the prefix arrives", async () => {
  await withService("zyron-devnet-p107f2-prefix", (service, chain) => {
    // Gossip order: re-add, then the removal at a future nonce, then the sender's earlier transfer.
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x23, 0x22, 0x21]
    });
    const remove = update(chain, [0x21, 0x22, 0x23], { nonce: 2, signers: [0x22, 0x23, 0x21] });
    const transfer = createTransfer({
      chainId: chain.genesis.chainId, nonce: 1, sender: addr(0x22), receiver: addr(0x30),
      amountAtoms: 1 * ZYN, feeAtoms: 0, timestampMs: T0 + 10
    }, key(0x22), pub(0x22));
    assert.throws(() => service.submitTransaction(readd), MISSING);
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), false, "the predecessor's nonce prefix is still incomplete");
    assert.equal(service.submitTransaction(transfer), transfer.txid);
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), true, "the re-add is re-tried once the prefix is complete");
    const at = chain.tip.header.timestampMs + 1_000;
    assert.deepEqual(
      chain.selectValidPending(service.mempool.values(), 10, undefined, at).map((tx) => tx.txid).sort(),
      [transfer.txid, remove.txid, readd.txid].sort()
    );
  });
});

// Codex P2s on #1104 (104e108).
test("P1-07-F2: variants with invalid possession-proof signatures cannot evict a deferred valid variant", async () => {
  await withService("zyron-devnet-p107f2-invalid-proofs", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    // The same quorum-approved update, re-signed by its sender with proofs whose
    // signatures do not verify (wrong activation height, another key's signature).
    const wrongHeight = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 301, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    const wrongKey = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, signers: [0x22, 0x23, 0x21],
      proofs: [{ address: addr(0x24), signature: proof(chain, 300, 0x25).signature }]
    });
    assert.notEqual(wrongHeight.txid, readd.txid);
    assert.notEqual(wrongKey.txid, readd.txid);
    assert.throws(() => service.submitTransaction(wrongHeight));
    assert.throws(() => service.submitTransaction(wrongKey));
    assert.equal(service.deferredValidatorUpdateCount(), 1, "variants with invalid proof signatures are not deferred");
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.values().some((tx) => tx.txid === readd.txid), true, "the valid variant survives");
  });
});

test("P1-07-F2: ordinary transactions do not copy the mempool while updates are deferred", async () => {
  await withService("zyron-devnet-p107f2-no-clone", (service, chain) => {
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x23, 0x22, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    assert.equal(service.deferredValidatorUpdateCount(), 1);
    const mempool = service.mempool as unknown as { values: () => Transaction[] };
    const original = mempool.values.bind(service.mempool);
    let copies = 0;
    mempool.values = () => { copies += 1; return original(); };
    try {
      // 0x22 sends no validator update: its transfers are not a retry trigger.
      for (let nonce = 1; nonce <= 3; nonce += 1) {
        const transfer = createTransfer({
          chainId: chain.genesis.chainId, nonce, sender: addr(0x22), receiver: addr(0x30),
          amountAtoms: 1 * ZYN, feeAtoms: 0, timestampMs: T0 + 10
        }, key(0x22), pub(0x22));
        assert.equal(service.submitTransaction(transfer), transfer.txid);
      }
    } finally {
      mempool.values = original;
    }
    assert.equal(copies, 0, "admitting an ordinary transaction must not copy the whole mempool");
  });
});

// Codex P2s on #1104 (cb863e16).
test("P1-07-F2: other variants of a re-admitted update stay deferred", async () => {
  await withService("zyron-devnet-p107f2-keep-variants", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    // The same approved update with another proof set (valid signatures),
    // which a different predecessor could need.
    const other = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x23), proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    assert.throws(() => service.submitTransaction(other));
    assert.equal(service.deferredValidatorUpdateCount(), 2);
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.has(readd.txid), true);
    assert.equal(service.deferredValidatorUpdateCount(), 1, "the variant that was not admitted is kept for a later re-try");
  });
});

test("P1-07-F2: re-trying deferred updates does not copy the whole mempool", async () => {
  await withService("zyron-devnet-p107f2-retry-no-clone", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    const mempool = service.mempool as unknown as { values: () => Transaction[] };
    const original = mempool.values.bind(service.mempool);
    let copies = 0;
    mempool.values = () => { copies += 1; return original(); };
    try {
      assert.equal(service.submitTransaction(remove), remove.txid);
    } finally {
      mempool.values = original;
    }
    assert.equal(service.mempool.has(readd.txid), true);
    assert.equal(copies, 0, "validator update admission and its re-tries must not copy the whole mempool");
  });
});

test("P1-07-F2: re-admission markers are kept while the update is still pending", async () => {
  await withService("zyron-devnet-p107f2-markers", (service, chain) => {
    const remove = update(chain, [0x21, 0x22, 0x23]);
    const readd = update(chain, [0x21, 0x22, 0x23, 0x24], {
      activationHeight: 300, nonce: 1, proofs: [proof(chain, 300, 0x24)], signers: [0x22, 0x23, 0x21]
    });
    assert.throws(() => service.submitTransaction(readd), MISSING);
    assert.equal(service.submitTransaction(remove), remove.txid);
    assert.equal(service.mempool.has(readd.txid), true);
    // Later triggers re-admit more updates (here: markers of updates that are
    // no longer pending) beyond the deferred-set size.
    const internals = service as unknown as { readmittedValidatorUpdateIds: string[]; retryDeferredValidatorUpdates: () => void };
    for (let index = 0; index < MAX_DEFERRED_VALIDATOR_UPDATES; index += 1) {
      internals.readmittedValidatorUpdateIds.push(index.toString(16).padStart(64, "f"));
    }
    internals.retryDeferredValidatorUpdates();
    assert.equal(service.submitTransaction(readd), readd.txid, "a pending re-admitted update is still an idempotent re-submit");
  });
});
