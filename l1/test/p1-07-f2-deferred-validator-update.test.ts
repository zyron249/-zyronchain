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

import { ZyronChain } from "../src/chain.js";
import { MAX_DEFERRED_VALIDATOR_UPDATES, NodeService } from "../src/node.js";
import { ChainStore } from "../src/storage.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createTransfer, createValidatorApproval, createValidatorSetUpdate } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig, type Validator, type ValidatorPossessionProof, type ValidatorSetUpdateTx } from "../src/types.js";
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
