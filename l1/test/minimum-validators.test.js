// Value-bearing genesis classes require at least four distinct validator keys.
// An explicit test class, and a genesis that omits networkClass, may keep fewer.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { STRICT_MIN_VALIDATORS } from "../src/network-class.js";
import { defaultPublicDistributionRelease } from "../src/public-distribution-release.js";
import { ChainStore } from "../src/storage.js";
import { createValidatorApproval, createValidatorSetUpdate } from "../src/transaction.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "../src/types.js";
import { signGenesisPossessionProofs, signValidatorUpdatePossessionProof } from "../src/validator-admission.js";
const ZYN = ATOMS_PER_ZYN;
const T0 = 1_700_000_000_000;
const TOO_FEW = /at least 4 and at most 100 distinct validators/;
const key = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => publicKeyFromPrivate(key(n));
const addr = (n) => addressFromPublicKey(pub(n));
function validator(n) {
    return { address: addr(n), publicKey: pub(n) };
}
function devGenesis(chainId, count, networkClass) {
    const pool = addr(0x90);
    const genesis = {
        chainId,
        timestampMs: T0,
        validators: Array.from({ length: count }, (_, index) => validator(0x30 + index)),
        activityOracles: [pub(0x91)],
        activityPool: pool,
        allocations: [{ address: pool, amountAtoms: 1_000 * ZYN }]
    };
    if (networkClass !== undefined)
        genesis.networkClass = networkClass;
    return genesis;
}
function strictGenesis(count, chainId = "zyron-review-validators") {
    const founder = addr(0x13);
    const distributed = addr(0x14);
    const liquidity = addr(0x15);
    const ecosystem = addr(0x16);
    // A value-bearing class also requires validator possession proofs (P1-07).
    return signGenesisPossessionProofs({
        chainId,
        timestampMs: T0,
        validators: Array.from({ length: count }, (_, index) => validator(0x21 + index)),
        activityOracles: [pub(0x12), pub(0x17), pub(0x18)],
        activityOracleThreshold: 2,
        activityOraclePolicy: "threshold-v1",
        activityPool: ecosystem,
        allocations: [
            { address: founder, amountAtoms: 5_000_000 * ZYN },
            { address: distributed, amountAtoms: 20_000_000 * ZYN },
            { address: liquidity, amountAtoms: 20_000_000 * ZYN },
            { address: ecosystem, amountAtoms: 5_000_000 * ZYN }
        ],
        allocationLocks: { founderVesting: founder, permanentLiquidity: liquidity },
        launchProfile: "fixed-supply-v1",
        networkClass: "mainnet",
        publicDistributionRelease: defaultPublicDistributionRelease(distributed)
    }, Array.from({ length: count }, (_, index) => key(0x21 + index)));
}
/** The fixed-supply profile without a value-bearing class (no proofs required). */
function profileOnlyGenesis(count, chainId) {
    const genesis = strictGenesis(count, chainId);
    delete genesis.networkClass;
    delete genesis.validatorAdmission;
    return genesis;
}
function signerId(genesis, signer) {
    const base = genesis.networkClass === "mainnet" ? 0x21 : 0x30;
    const index = genesis.validators.findIndex((item) => item.address === signer.address);
    if (index < 0)
        throw new Error("signer is not in the genesis set");
    return base + index;
}
// `incoming` are the key ids of validators that are new relative to the genesis
// set; on a chain with validatorAdmission (P1-07) each signs a possession proof.
function validatorUpdate(genesis, next, incoming = []) {
    const quorum = Math.floor((genesis.validators.length * 2) / 3) + 1;
    const signers = genesis.validators.slice(0, quorum);
    const sender = signers[0];
    const input = {
        chainId: genesis.chainId,
        nonce: 1,
        sender: sender.address,
        activationHeight: 150,
        validators: next
    };
    const approvals = signers.map((signer) => createValidatorApproval(input, key(signerId(genesis, signer)), signer.publicKey));
    const possessionProofs = genesis.validatorAdmission === undefined ? undefined : incoming.map((id) => signValidatorUpdatePossessionProof({
        chainId: genesis.chainId,
        genesisHash: new ZyronChain(genesis).genesisHash,
        activationHeight: input.activationHeight,
        validator: validator(id)
    }, key(id)));
    return createValidatorSetUpdate({
        ...input,
        approvals,
        ...(possessionProofs === undefined ? {} : { possessionProofs }),
        timestampMs: T0 + 10
    }, key(signerId(genesis, sender)), sender.publicKey);
}
test("the value-bearing minimum is four distinct validators", () => {
    assert.equal(STRICT_MIN_VALIDATORS, 4);
});
test("a value-bearing genesis with fewer than four validators is rejected at construction and node start", async () => {
    for (const count of [1, 2, 3]) {
        const genesis = strictGenesis(count, `zyron-review-n${count}`);
        assert.throws(() => new ZyronChain(genesis), TOO_FEW);
    }
    const profileOnly = profileOnlyGenesis(3, "zyron-profile-few");
    assert.throws(() => new ZyronChain(profileOnly), TOO_FEW);
    const directory = await mkdtemp(join(tmpdir(), "zyron-min-validators-"));
    try {
        await assert.rejects(() => ChainStore.open(strictGenesis(3, "zyron-review-open"), directory), TOO_FEW);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("a value-bearing genesis with four distinct validators starts and keeps the 50M supply", async () => {
    const genesis = strictGenesis(4);
    const openProfile = profileOnlyGenesis(4, "zyron-open-profile");
    assert.equal(new ZyronChain(openProfile).validatorsAt(1).length, 4);
    const chain = new ZyronChain(genesis);
    assert.equal(chain.validatorsAt(1).length, 4);
    assert.equal(new Set(chain.validatorsAt(1).map((item) => item.address)).size, 4);
    assert.equal(new Set(chain.validatorsAt(1).map((item) => item.publicKey)).size, 4);
    assert.equal(chain.totalSupplyAtoms(), MAX_SUPPLY_ATOMS);
    const directory = await mkdtemp(join(tmpdir(), "zyron-min-ok-"));
    try {
        const store = await ChainStore.open(genesis, directory);
        assert.equal(store.chain.validatorsAt(1).length, 4);
    }
    finally {
        await rm(directory, { recursive: true, force: true });
    }
});
test("explicit test classes and omitted classes may keep fewer than four validators", () => {
    assert.equal(new ZyronChain(devGenesis("zyron-local-0123abcd", 1)).validatorsAt(1).length, 1);
    assert.equal(new ZyronChain(devGenesis("zyron-wallet-testnet-1", 1)).validatorsAt(1).length, 1);
    assert.equal(new ZyronChain(devGenesis("zyron-open-testnet-1", 2)).validatorsAt(1).length, 2);
    assert.equal(new ZyronChain(devGenesis("zyron-render-private-testnet-1", 3)).validatorsAt(1).length, 3);
    for (const networkClass of ["devnet", "local-devnet", "testnet", "private-testnet", "open-testnet", "wallet-testnet"]) {
        assert.equal(new ZyronChain(devGenesis(`zyron-${networkClass}-few`, 1, networkClass)).validatorsAt(1).length, 1);
    }
    assert.throws(() => new ZyronChain(devGenesis("zyron-devnet-1", 0)), /between 1 and 100/);
    assert.throws(() => new ZyronChain(devGenesis("zyron-devnet-1", 101)), /between 1 and 100/);
    assert.throws(() => new ZyronChain(strictGenesis(101, "zyron-review-wide")), TOO_FEW);
});
test("duplicate validator keys and mismatched addresses are rejected", () => {
    const duplicated = devGenesis("zyron-devnet-dup", 1);
    duplicated.validators = [validator(1), validator(1)];
    assert.throws(() => new ZyronChain(duplicated), /Duplicate validator public key/);
    const mismatched = devGenesis("zyron-devnet-mismatch", 1);
    mismatched.validators = [{ address: addr(1), publicKey: pub(2) }];
    assert.throws(() => new ZyronChain(mismatched), /address\/public key mismatch/);
    const strictDup = strictGenesis(4);
    strictDup.validators = [validator(1), validator(2), validator(3), validator(1)];
    assert.throws(() => new ZyronChain(strictDup), /Duplicate validator public key/);
});
test("a value-bearing chain refuses a validator update below four, including at a checkpoint", () => {
    const genesis = strictGenesis(4);
    const chain = new ZyronChain(genesis);
    const tooSmall = validatorUpdate(genesis, [validator(0x41), validator(0x42), validator(0x43)]);
    assert.deepEqual(chain.selectValidPending([tooSmall], 10), []);
    assert.throws(() => chain.produceBlock([tooSmall], key(0x21), { timestampMs: T0 + 1_000 }), TOO_FEW);
    const replacement = validatorUpdate(genesis, [validator(0x41), validator(0x42), validator(0x43), validator(0x44)], [0x41, 0x42, 0x43, 0x44]);
    assert.equal(chain.selectValidPending([replacement], 10).length, 1);
    const copied = validatorUpdate(genesis, [validator(0x41), validator(0x41), validator(0x43), validator(0x44)]);
    assert.throws(() => chain.produceBlock([copied], key(0x21), { timestampMs: T0 + 1_000 }), /Duplicate validator public key/);
    const snapshot = structuredClone(chain.snapshot());
    const open = (schedule) => {
        const value = { ...snapshot, validatorSchedule: schedule };
        return ZyronChain.fromTrustedSnapshot(genesis, value, {
            tipHash: chain.tip.hash,
            snapshotSha256: sha256Hex(canonicalJson(value))
        });
    };
    const base = snapshot.validatorSchedule;
    assert.throws(() => open([...base, { activationHeight: 200, validators: [validator(7), validator(8), validator(9)] }]), TOO_FEW);
    assert.throws(() => open([...base, {
            activationHeight: 200,
            validators: [validator(7), validator(7), validator(9), validator(10)]
        }]), /Duplicate validator public key/);
    assert.doesNotThrow(() => open([...base, {
            activationHeight: 200,
            validators: [validator(7), validator(8), validator(9), validator(10)]
        }]));
});
test("a dev genesis can still replace its set with a single validator", () => {
    const genesis = devGenesis("zyron-devnet-shrink", 2);
    const chain = new ZyronChain(genesis);
    const quorum = genesis.validators;
    const input = {
        chainId: genesis.chainId,
        nonce: 1,
        sender: quorum[0].address,
        activationHeight: 150,
        validators: [validator(0x70)]
    };
    const approvals = quorum.map((signer, index) => createValidatorApproval(input, key(0x30 + index), signer.publicKey));
    const update = createValidatorSetUpdate({ ...input, approvals, timestampMs: T0 + 10 }, key(0x30), quorum[0].publicKey);
    assert.equal(chain.selectValidPending([update], 10).length, 1);
    assert.doesNotThrow(() => chain.produceBlock([update], key(0x30), { timestampMs: T0 + 1_000 }));
});
