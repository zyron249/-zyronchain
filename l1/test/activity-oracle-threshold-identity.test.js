// PR #969 review follow-up (chatgpt-codex-connector[bot] findings P1 and P2).
//
// P1 identity binding: `activityOracleThreshold` changes block validity, so
// two nodes that differ only in the threshold must not share a chain identity
// (genesis hash, which the P2P handshake, snapshots, checkpoints and block 1's
// parent link all compare). A genesis that declares a threshold now carries
// the full genesis-configuration commitment in the genesis header's
// previous-hash slot, using exactly the commitment defined in PR #961
// (`zyronchain/genesis-config/v1`). Genesis files without a threshold keep the
// zero previous hash and therefore their historical genesis hash.
//
// P2 oracle key validation: under a threshold genesis every activity-oracle
// key must be a valid secp256k1 point (as validator keys are since F-05), so
// an unusable key can never be counted in n and make m unreachable. Legacy
// genesis files keep the old 64-hex check so existing chains still open.
import assert from "node:assert/strict";
import test from "node:test";
import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { ATOMS_PER_ZYN } from "../src/types.js";
const ZYN = ATOMS_PER_ZYN;
const key = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => publicKeyFromPrivate(key(n));
const addr = (n) => addressFromPublicKey(pub(n));
const VALIDATOR = 0x91;
const O1 = 0x92;
const O2 = 0x93;
const O3 = 0x94;
const ECOSYSTEM = 0x95;
const HOLDER = 0x96;
// Well-formed 64-byte lowercase hex (x || y) that is not a point on secp256k1:
// all zeros, and (1, 1).
const NOT_A_POINT = ["00".repeat(64), "00".repeat(31) + "01" + "00".repeat(31) + "01"];
function genesisWith(threshold, oracles = [pub(O1), pub(O2), pub(O3)]) {
    const genesis = {
        chainId: "zyron-mofn-identity",
        timestampMs: 1_700_000_000_000,
        validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
        activityOracles: oracles,
        activityPool: addr(ECOSYSTEM),
        allocations: [
            { address: addr(HOLDER), amountAtoms: 45_000_000 * ZYN },
            { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
        ]
    };
    return threshold === undefined ? genesis : { ...genesis, activityOracleThreshold: threshold };
}
const commitment = (genesis) => sha256Hex(canonicalJson({ domain: "zyronchain/genesis-config/v1", genesis }));
test("ORACLE-MOFN identity: thresholds 1, 2 and 3 over the same oracles are distinct chains", () => {
    const legacy = new ZyronChain(genesisWith(undefined));
    const hashes = [1, 2, 3].map((m) => new ZyronChain(genesisWith(m)).genesisHash);
    assert.equal(new Set([legacy.genesisHash, ...hashes]).size, 4, "legacy and each threshold must differ");
});
test("ORACLE-MOFN identity: a threshold genesis commits the full configuration (same commitment as #961)", () => {
    for (const m of [1, 2, 3]) {
        const genesis = genesisWith(m);
        const chain = new ZyronChain(genesis);
        assert.equal(chain.tip.header.previousHash, commitment(genesis), `threshold ${m}`);
    }
    assert.equal(new ZyronChain(genesisWith(undefined)).tip.header.previousHash, "0".repeat(64));
});
test("ORACLE-MOFN identity: a block built on a threshold-1 genesis does not extend a threshold-2 genesis", () => {
    const one = new ZyronChain(genesisWith(1));
    const two = new ZyronChain(genesisWith(2));
    const timestampMs = genesisWith(1).timestampMs + 1_000;
    const block = one.attestBlock(one.produceBlock([], key(VALIDATOR), { timestampMs }), key(VALIDATOR));
    one.acceptBlock(block, timestampMs);
    assert.equal(one.height, 1);
    assert.throws(() => two.acceptBlock(block, timestampMs));
    assert.equal(two.height, 0);
});
test("ORACLE-MOFN oracle keys: a threshold genesis rejects activity-oracle keys that are not secp256k1 points", () => {
    for (const bad of NOT_A_POINT) {
        assert.throws(() => new ZyronChain(genesisWith(2, [pub(O1), pub(O2), bad])), /activity oracle public key is not a valid secp256k1 point/i, bad);
    }
});
test("ORACLE-MOFN oracle keys: legacy genesis (no threshold) keeps the historical 64-hex check", () => {
    for (const bad of NOT_A_POINT)
        new ZyronChain(genesisWith(undefined, [pub(O1), bad]));
});
