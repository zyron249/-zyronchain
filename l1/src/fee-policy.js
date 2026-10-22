import { FIXED_SUPPLY_LAUNCH_PROFILE } from "./tokenomics.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "./types.js";
/**
 * Fee policy v1 (protocol rule version `fixed-fee-v1`).
 *
 * Opt-in on a `launchProfile: "fixed-supply-v1"` genesis via `feePolicy`.
 * Genesis files that omit `feePolicy` keep the historical rules: any
 * non-negative transfer fee is accepted, the whole fee is burned, and local
 * mempool ordering may still prefer a higher fee. Existing testnet and
 * historical blocks therefore validate exactly as before.
 *
 * The rule is not activated on any shipped genesis. Mainnet activation flags
 * stay false. See docs/FEE_POLICY_V1.md.
 */
export const FEE_POLICY_V1 = "fixed-fee-v1";
/**
 * Proposed launch default: 0.001 ZYN.
 * 1 ZYN = 100,000,000 atoms, so 0.001 ZYN = ATOMS_PER_ZYN / 1_000 = 100,000 atoms.
 * This is the single tunable parameter. A genesis that opts in commits to its
 * own positive integer `fixedTransferFeeAtoms`; nodes do not invent a second fee.
 */
export const FIXED_TRANSFER_FEE_ATOMS = ATOMS_PER_ZYN / 1_000;
export const FIXED_FEE_MISMATCH_MESSAGE = "Transfer fee must equal the fixed protocol fee";
/**
 * Per-sender mempool cap. A sender may have at most this many pending
 * transactions, which is also the nonce window above the confirmed nonce
 * (`stateNonce + 1` through `stateNonce + cap`).
 */
export const MAX_MEMPOOL_PENDING_PER_SENDER = 64;
/**
 * Odd atom goes to the burn. `burnAtoms + producerAtoms === feeAtoms`,
 * `burnAtoms >= producerAtoms`, and `burnAtoms - producerAtoms` is 0 or 1.
 */
export function splitFixedFee(feeAtoms) {
    if (!Number.isSafeInteger(feeAtoms) || feeAtoms < 0)
        throw new Error("Invalid fixed transfer fee");
    const producerAtoms = Math.floor(feeAtoms / 2);
    return { burnAtoms: feeAtoms - producerAtoms, producerAtoms };
}
export function readFeePolicy(genesis) {
    if (!Object.prototype.hasOwnProperty.call(genesis, "feePolicy"))
        return undefined;
    return genesis.feePolicy;
}
export function feePolicyActive(genesis) {
    return readFeePolicy(genesis)?.version === FEE_POLICY_V1;
}
/**
 * Fail-closed genesis check. Absent `feePolicy` leaves every rule unchanged.
 * Present `feePolicy` is accepted only as fixed-fee-v1 on fixed-supply-v1,
 * with one positive integer fee.
 */
export function validateGenesisFeePolicy(genesis) {
    if (!Object.prototype.hasOwnProperty.call(genesis, "feePolicy"))
        return;
    const policy = genesis.feePolicy;
    if (policy === null || typeof policy !== "object" || Array.isArray(policy)) {
        throw new Error("Invalid fixed-fee policy");
    }
    const keys = Object.keys(policy).sort();
    if (keys.length !== 2 || keys[0] !== "fixedTransferFeeAtoms" || keys[1] !== "version") {
        throw new Error("Invalid fixed-fee policy");
    }
    const record = policy;
    if (record.version !== FEE_POLICY_V1)
        throw new Error("Unsupported fixed-fee policy version");
    if (genesis.launchProfile !== FIXED_SUPPLY_LAUNCH_PROFILE) {
        throw new Error("fixed-fee-v1 requires launchProfile fixed-supply-v1");
    }
    const fee = record.fixedTransferFeeAtoms;
    if (typeof fee !== "number" || !Number.isSafeInteger(fee) || fee < 1 || fee > MAX_SUPPLY_ATOMS) {
        throw new Error("Invalid fixed transfer fee");
    }
}
/** Mempool nonce window. The error text is part of the node admission contract. */
export function assertMempoolSenderNonce(txNonce, stateNonce) {
    if (!Number.isSafeInteger(txNonce) || !Number.isSafeInteger(stateNonce) ||
        txNonce <= stateNonce || txNonce > stateNonce + MAX_MEMPOOL_PENDING_PER_SENDER) {
        throw new Error("Transaction nonce outside mempool window");
    }
}
