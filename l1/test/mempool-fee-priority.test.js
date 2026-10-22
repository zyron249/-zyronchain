import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson } from "../src/codec.js";
import { orderPendingByFeePriority, ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createTransfer, createValidatorApproval, createValidatorSetUpdate } from "../src/transaction.js";
// External reviewer note EXT-01: selection used to be ordered by sender
// address, so lexicographically small addresses always won regardless of fee.
const key = (n) => n.toString(16).padStart(64, "0");
const validatorPrivate = key(1);
const oraclePublic = publicKeyFromPrivate(key(4));
const activityPool = addressFromPublicKey(publicKeyFromPrivate(key(6)));
const accounts = [key(3), key(5), key(9), key(10)].map((privateKey) => {
    const publicKey = publicKeyFromPrivate(privateKey);
    return { privateKey, publicKey, address: addressFromPublicKey(publicKey) };
}).sort((a, b) => (a.address < b.address ? -1 : 1));
const low = accounts[0]; // lexicographically smallest address
const high = accounts[accounts.length - 1]; // largest address
function genesis() {
    const validatorPublic = publicKeyFromPrivate(validatorPrivate);
    return {
        chainId: "zyron-devnet-1",
        timestampMs: 1_700_000_000_000,
        validators: [{ address: addressFromPublicKey(validatorPublic), publicKey: validatorPublic }],
        activityOracles: [oraclePublic],
        activityPool,
        allocations: [
            ...accounts.map((account) => ({ address: account.address, amountAtoms: 1_000_000_000 })),
            { address: activityPool, amountAtoms: 5_000_000_000 }
        ]
    };
}
function transfer(from, nonce, feeAtoms, timestampMs = 100) {
    return createTransfer({ chainId: genesis().chainId, nonce, sender: from.address, receiver: accounts[1].address, amountAtoms: 1, feeAtoms, timestampMs }, from.privateKey, from.publicKey);
}
test("higher fee wins across senders regardless of address order", () => {
    const chain = new ZyronChain(genesis());
    const cheap = transfer(low, 1, 1);
    const rich = transfer(high, 1, 50);
    assert.deepEqual(chain.selectValidPending([cheap, rich], 10).map((tx) => tx.txid), [rich.txid, cheap.txid]);
    const budget = Buffer.byteLength(canonicalJson(rich), "utf8");
    assert.deepEqual(chain.selectValidPending([cheap, rich], 10, budget).map((tx) => tx.txid), [rich.txid]);
    assert.deepEqual(chain.selectValidPending([cheap, rich], 1).map((tx) => tx.txid), [rich.txid]);
});
test("per-sender nonce order is preserved while interleaving by fee", () => {
    const chain = new ZyronChain(genesis());
    const a1 = transfer(low, 1, 1);
    const a2 = transfer(low, 2, 100);
    const b1 = transfer(high, 1, 10);
    assert.deepEqual(chain.selectValidPending([a2, b1, a1], 10).map((tx) => tx.txid), [b1.txid, a1.txid, a2.txid]);
});
test("ordering is deterministic for any input permutation", () => {
    const txs = [transfer(low, 1, 5), transfer(low, 2, 5), transfer(high, 1, 5, 99), transfer(accounts[1], 1, 5, 99), transfer(accounts[2], 1, 7)];
    const expected = orderPendingByFeePriority(txs).map((tx) => tx.txid);
    for (let i = 0; i < 20; i += 1) {
        const shuffled = [...txs].sort(() => Math.random() - 0.5);
        assert.deepEqual(orderPendingByFeePriority(shuffled).map((tx) => tx.txid), expected);
    }
    assert.equal(expected[0], txs[4].txid, "highest fee first");
});
test("zero-fee protocol transactions are not starved by fee-paying transfers", () => {
    const richTransfer = transfer(low, 1, 1_000);
    const settlement = { ...transfer(high, 1, 0), kind: "activity_settlement" };
    assert.deepEqual(orderPendingByFeePriority([richTransfer, settlement]).map((tx) => tx.kind), ["activity_settlement", "transfer"]);
});
test("same sender and nonce alternatives: higher fee is tried first", () => {
    const chain = new ZyronChain(genesis());
    const first = transfer(low, 1, 1);
    const bump = transfer(low, 1, 9, 101);
    assert.deepEqual(chain.selectValidPending([first, bump], 10).map((tx) => tx.txid), [bump.txid]);
});
// Round-18 independent retest of #1041 (R18-1041-L1, R18-1041-L2).
function governanceGenesis() {
    return { ...genesis(), validators: [low, high].map(({ address, publicKey }) => ({ address, publicKey })) };
}
function validatorUpdate(from, nonce, activationHeight, timestampMs, approve = true) {
    const base = governanceGenesis();
    const input = { chainId: base.chainId, sender: from.address, nonce, activationHeight, validators: base.validators };
    const approvals = approve ? [low, high].map((validator) => createValidatorApproval(input, validator.privateKey, validator.publicKey)) : [];
    return createValidatorSetUpdate({ ...input, approvals, timestampMs }, from.privateKey, from.publicKey);
}
test("validator updates from different senders are selected in activation-height order (R18-1041-L1)", () => {
    const chain = new ZyronChain(governanceGenesis());
    const early = validatorUpdate(low, 1, 150, 120); // earlier activation, later timestamp
    const late = validatorUpdate(high, 1, 250, 110);
    for (const input of [[early, late], [late, early]]) {
        assert.deepEqual(chain.selectValidPending(input, 10).map((tx) => tx.txid), [early.txid, late.txid]);
    }
});
test("an authorized protocol transaction lifts its sender's nonce predecessors above fee-paying transfers (R18-1041-L2)", () => {
    const chain = new ZyronChain(governanceGenesis());
    const cheap = transfer(low, 1, 1);
    const update = validatorUpdate(low, 2, 150, 102);
    const rich1 = transfer(high, 1, 100);
    const rich2 = transfer(high, 2, 100);
    assert.deepEqual(chain.selectValidPending([rich1, rich2, update, cheap], 2).map((tx) => tx.txid), [cheap.txid, update.txid]);
});
test("every authorized protocol transaction in a lane lifts its own predecessors, not only the first", () => {
    const chain = new ZyronChain(governanceGenesis());
    const first = validatorUpdate(low, 1, 150, 101);
    const cheap = transfer(low, 2, 1);
    const second = validatorUpdate(low, 3, 250, 103);
    const rich1 = transfer(high, 1, 100);
    const rich2 = transfer(high, 2, 100);
    assert.deepEqual(chain.selectValidPending([rich1, rich2, second, cheap, first], 3).map((tx) => tx.txid), [first.txid, cheap.txid, second.txid]);
});
test("an unauthorized protocol transaction does not lift its sender's predecessors", () => {
    const chain = new ZyronChain(governanceGenesis());
    const cheap = transfer(low, 1, 1);
    const unapproved = validatorUpdate(low, 2, 150, 102, false);
    const rich1 = transfer(high, 1, 100);
    const rich2 = transfer(high, 2, 100);
    assert.deepEqual(chain.selectValidPending([cheap, unapproved, rich1, rich2], 2).map((tx) => tx.txid), [rich1.txid, rich2.txid]);
    // The pure ordering never lifts predecessors unless the caller vouches for the protocol transaction.
    const fake = { ...transfer(low, 2, 0), kind: "validator_update", activationHeight: 150 };
    assert.deepEqual(orderPendingByFeePriority([cheap, fake, rich1]).map((tx) => tx.txid), [rich1.txid, cheap.txid, fake.txid]);
});
test("protocol ordering is a total order: deterministic for every permutation", () => {
    const governance = (from, kind, activationHeight, timestampMs) => ({ ...transfer(from, 1, 0, timestampMs), kind, activationHeight });
    const a = governance(low, "validator_update", 100, 130);
    const b = governance(high, "validator_update", 200, 110);
    const c = governance(accounts[1], "protocol_upgrade", 50, 120);
    const d = transfer(accounts[2], 1, 9);
    const all = [a, b, c, d];
    const expected = orderPendingByFeePriority(all).map((tx) => tx.txid);
    const permutations = (items) => items.length <= 1 ? [items] :
        items.flatMap((item, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]));
    for (const permutation of permutations(all)) {
        assert.deepEqual(orderPendingByFeePriority(permutation).map((tx) => tx.txid), expected);
    }
    assert.ok(expected.indexOf(a.txid) < expected.indexOf(b.txid), "lower validator activation first");
    assert.equal(expected[3], d.txid, "transfers after protocol transactions");
});
