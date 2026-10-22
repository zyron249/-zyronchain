import { canonicalJson, compareCanonicalStrings, sha256Hex } from "./codec.js";
import { FIXED_FEE_MISMATCH_MESSAGE, splitFixedFee } from "./fee-policy.js";
import { MINING_TRACKER_ADDRESS, rejectRetiredMiningClaim } from "./mining.js";
import { ACTIVITY_ORDER_MESSAGE, ACTIVITY_WINDOW_AMOUNT_ADDRESS, ACTIVITY_WINDOW_RESERVED_MESSAGE, ACTIVITY_WINDOW_TIME_ADDRESS, activityRollingWindowEnforced, activitySettlementCapAtoms, assertActivityRollingWindow, assertActivitySettlementWithinCap, assertNoActivityPoolDirectDebit, isActivityWindowAddress } from "./activity.js";
import { assertActivitySettlementAuthorized } from "./activity-oracle.js";
import { assertAllocationLockOutflow } from "./allocation-locks.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";
import { assertAddress, assertExactKeys, assertPlainRecord } from "./transaction.js";
export class LedgerState {
    accounts;
    settledActivityEpochs;
    constructor(accounts = new Map(), epochs = new Set()) {
        this.accounts = accounts;
        this.settledActivityEpochs = epochs;
    }
    static fromGenesis(genesis) {
        const state = new LedgerState();
        let supply = 0;
        for (const allocation of genesis.allocations) {
            if (!Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) {
                throw new Error("Invalid genesis allocation");
            }
            supply += allocation.amountAtoms;
            if (!Number.isSafeInteger(supply) || supply > MAX_SUPPLY_ATOMS) {
                throw new Error("Genesis supply exceeds maximum supply");
            }
            state.credit(allocation.address, allocation.amountAtoms);
        }
        return state;
    }
    static fromSnapshot(value) {
        assertPlainRecord(value, "ledger snapshot");
        assertExactKeys(value, ["accounts", "settledActivityEpochs"], "ledger snapshot");
        if (!Array.isArray(value.accounts) || !Array.isArray(value.settledActivityEpochs)) {
            throw new Error("Invalid ledger snapshot");
        }
        const accounts = new Map();
        let supply = 0;
        let previousAddress = "";
        for (const candidate of value.accounts) {
            assertPlainRecord(candidate, "ledger snapshot account");
            assertExactKeys(candidate, ["address", "balanceAtoms", "nonce"], "ledger snapshot account");
            if (typeof candidate.address !== "string")
                throw new Error("Invalid ledger snapshot address");
            assertAddress(candidate.address);
            if (candidate.address <= previousAddress)
                throw new Error("Ledger snapshot accounts are not canonical");
            previousAddress = candidate.address;
            if (!Number.isSafeInteger(candidate.balanceAtoms) || Number(candidate.balanceAtoms) < 0 ||
                !Number.isSafeInteger(candidate.nonce) || Number(candidate.nonce) < 0) {
                throw new Error("Invalid ledger snapshot account state");
            }
            supply += Number(candidate.balanceAtoms);
            if (!Number.isSafeInteger(supply) || supply > MAX_SUPPLY_ATOMS)
                throw new Error("Ledger snapshot supply exceeds maximum");
            accounts.set(candidate.address, { balanceAtoms: Number(candidate.balanceAtoms), nonce: Number(candidate.nonce) });
        }
        const epochs = new Set();
        let previousEpoch = -1;
        for (const candidate of value.settledActivityEpochs) {
            if (!Number.isSafeInteger(candidate) || Number(candidate) < 0 || Number(candidate) <= previousEpoch) {
                throw new Error("Invalid ledger snapshot activity epochs");
            }
            previousEpoch = Number(candidate);
            epochs.add(Number(candidate));
        }
        return new LedgerState(accounts, epochs);
    }
    clone() {
        return new LedgerState(new Map([...this.accounts].map(([address, account]) => [address, { ...account }])), new Set(this.settledActivityEpochs));
    }
    balance(address) {
        return this.accounts.get(address)?.balanceAtoms ?? 0;
    }
    nonce(address) {
        return this.accounts.get(address)?.nonce ?? 0;
    }
    totalSupplyAtoms() {
        let supply = 0;
        for (const account of this.accounts.values()) {
            supply += account.balanceAtoms;
            if (!Number.isSafeInteger(supply) || supply > MAX_SUPPLY_ATOMS) {
                throw new Error("Ledger supply exceeds maximum");
            }
        }
        return supply;
    }
    miningClaimCount() {
        return this.nonce(MINING_TRACKER_ADDRESS);
    }
    isActivityEpochSettled(epoch) {
        return this.settledActivityEpochs.has(epoch);
    }
    /**
     * `locks` carries the genesis allocation locks evaluated at the including
     * block's timestamp; chain paths always pass it (undefined only when the
     * genesis declares no locks). See allocation-locks.ts.
     * `oracles` carries the genesis activity-oracle keys and optional m-of-n
     * threshold; chain paths always pass it (activity-oracle.ts). Direct callers
     * that omit it get the historical applier, which never checked the signer.
     * `fee` is set only under fixed-fee-v1. Omitted, the whole fee is burned.
     */
    apply(tx, activityPool, locks, oracles, fee) {
        const rollingWindow = activityRollingWindowEnforced(oracles);
        if (tx.kind === "transfer") {
            assertNoActivityPoolInflow(tx.receiver, activityPool);
            assertNoActivityPoolDirectDebit(tx.sender, activityPool, oracles);
            if (rollingWindow && isActivityWindowAddress(tx.receiver))
                throw new Error(ACTIVITY_WINDOW_RESERVED_MESSAGE);
            this.applyTransfer(tx, locks, activityPool, fee);
        }
        else if (tx.kind === "activity_settlement") {
            if (oracles) {
                assertActivitySettlementAuthorized(tx, oracles, {
                    chainId: tx.chainId,
                    ...(locks?.blockTimestampMs !== undefined ? { blockTimestampMs: locks.blockTimestampMs } : {}),
                    ...(oracles.timestampMs !== undefined ? { genesisTimestampMs: oracles.timestampMs } : {})
                });
            }
            this.applyActivity(tx, activityPool, locks, rollingWindow, activitySettlementCapAtoms(oracles));
        }
        else if (tx.kind === "mining_claim")
            this.applyMining(tx);
        else if (tx.kind === "validator_update")
            this.applyValidatorUpdate(tx);
        else if (tx.kind === "activity_oracle_governance")
            this.applyActivityOracleGovernance(tx);
        else
            this.applyProtocolUpgrade(tx);
    }
    root() {
        return sha256Hex(canonicalJson(this.snapshot()));
    }
    snapshot() {
        return {
            accounts: [...this.accounts.entries()]
                .sort(([a], [b]) => compareCanonicalStrings(a, b))
                .map(([address, state]) => ({ address, ...state })),
            settledActivityEpochs: [...this.settledActivityEpochs].sort((a, b) => a - b)
        };
    }
    applyTransfer(tx, locks, activityPool, fee) {
        if (tx.sender === MINING_TRACKER_ADDRESS || tx.receiver === MINING_TRACKER_ADDRESS) {
            throw new Error("Mining tracker address is protocol-reserved");
        }
        this.requireNonce(tx.sender, tx.nonce);
        const total = tx.amountAtoms + tx.feeAtoms;
        if (!Number.isSafeInteger(total) || this.balance(tx.sender) < total) {
            throw new Error("Insufficient balance");
        }
        assertAllocationLockOutflow(locks, tx.sender, this.balance(tx.sender), total);
        this.debit(tx.sender, total);
        this.credit(tx.receiver, tx.amountAtoms);
        if (fee)
            this.creditProducerFee(tx.feeAtoms, fee, activityPool);
        this.setNonce(tx.sender, tx.nonce);
    }
    /**
     * fixed-fee-v1 only. floor(fee/2) is credited to the block producer.
     * The remainder, including the odd atom, is not credited and stays burned.
     * A zero producer share writes nothing, so the account set is unchanged.
     */
    creditProducerFee(feeAtoms, fee, activityPool) {
        if (feeAtoms !== fee.fixedTransferFeeAtoms)
            throw new Error(FIXED_FEE_MISMATCH_MESSAGE);
        const { producerAtoms } = splitFixedFee(feeAtoms);
        if (producerAtoms <= 0)
            return;
        if (fee.producer === MINING_TRACKER_ADDRESS)
            throw new Error("Mining tracker address is protocol-reserved");
        assertNoActivityPoolInflow(fee.producer, activityPool);
        this.credit(fee.producer, producerAtoms);
    }
    applyActivity(tx, activityPool, locks, rollingWindow = false, capAtoms = activitySettlementCapAtoms(undefined)) {
        if (tx.sender !== activityPool)
            throw new Error("Invalid activity pool sender");
        for (const entry of tx.entries)
            assertNoActivityPoolInflow(entry.receiver, activityPool);
        if (tx.entries.some((entry) => entry.receiver === MINING_TRACKER_ADDRESS)) {
            throw new Error("Mining tracker address is protocol-reserved");
        }
        if (this.settledActivityEpochs.has(tx.epoch))
            throw new Error("Activity epoch already settled");
        // Defence in depth for epoch ordering: never settle an epoch below an
        // adjacent settled one. Full ordering comes from the chain-level window
        // (only the most recently closed epoch is settleable), which this applier
        // cannot see because it has no block timestamp.
        if (this.settledActivityEpochs.has(tx.epoch + 1))
            throw new Error(ACTIVITY_ORDER_MESSAGE);
        this.requireNonce(activityPool, tx.nonce);
        const total = assertActivitySettlementWithinCap(tx.entries, capAtoms);
        if (rollingWindow) {
            if (tx.entries.some((entry) => isActivityWindowAddress(entry.receiver))) {
                throw new Error(ACTIVITY_WINDOW_RESERVED_MESSAGE);
            }
            assertActivityRollingWindow({
                timestampMs: this.nonce(ACTIVITY_WINDOW_TIME_ADDRESS),
                amountAtoms: this.nonce(ACTIVITY_WINDOW_AMOUNT_ADDRESS)
            }, locks?.blockTimestampMs, total, capAtoms);
        }
        if (this.balance(activityPool) < total)
            throw new Error("Activity pool exhausted");
        assertAllocationLockOutflow(locks, activityPool, this.balance(activityPool), total);
        this.debit(activityPool, total);
        for (const entry of tx.entries)
            this.credit(entry.receiver, entry.amountAtoms);
        this.setNonce(activityPool, tx.nonce);
        this.settledActivityEpochs.add(tx.epoch);
        if (rollingWindow) {
            this.setNonce(ACTIVITY_WINDOW_TIME_ADDRESS, locks.blockTimestampMs);
            this.setNonce(ACTIVITY_WINDOW_AMOUNT_ADDRESS, total);
        }
    }
    /** EXT-04: mining is retired; explicit rejection only, no issuance logic. */
    applyMining(_tx) {
        return rejectRetiredMiningClaim();
    }
    applyActivityOracleGovernance(tx) {
        if (tx.sender === MINING_TRACKER_ADDRESS)
            throw new Error("Mining tracker address is protocol-reserved");
        this.requireNonce(tx.sender, tx.nonce);
        this.setNonce(tx.sender, tx.nonce);
    }
    applyValidatorUpdate(tx) {
        if (tx.sender === MINING_TRACKER_ADDRESS)
            throw new Error("Mining tracker address is protocol-reserved");
        this.requireNonce(tx.sender, tx.nonce);
        this.setNonce(tx.sender, tx.nonce);
    }
    applyProtocolUpgrade(tx) {
        if (tx.sender === MINING_TRACKER_ADDRESS)
            throw new Error("Mining tracker address is protocol-reserved");
        this.requireNonce(tx.sender, tx.nonce);
        this.setNonce(tx.sender, tx.nonce);
    }
    requireNonce(address, nonce) {
        if (nonce !== this.nonce(address) + 1)
            throw new Error("Invalid nonce");
    }
    credit(address, amount) {
        const current = this.balance(address);
        const next = current + amount;
        if (!Number.isSafeInteger(next) || next > MAX_SUPPLY_ATOMS)
            throw new Error("Balance overflow");
        const account = this.accounts.get(address) ?? { balanceAtoms: 0, nonce: 0 };
        account.balanceAtoms = next;
        this.accounts.set(address, account);
    }
    debit(address, amount) {
        const account = this.accounts.get(address) ?? { balanceAtoms: 0, nonce: 0 };
        if (account.balanceAtoms < amount)
            throw new Error("Insufficient balance");
        account.balanceAtoms -= amount;
        this.accounts.set(address, account);
    }
    setNonce(address, nonce) {
        const account = this.accounts.get(address) ?? { balanceAtoms: 0, nonce: 0 };
        account.nonce = nonce;
        this.accounts.set(address, account);
    }
}
/**
 * The activity pool is outflow-only: cumulative activity settlements can never
 * exceed the pool's genesis allocation (ZC-CRY-20260930-006).
 */
export function assertNoActivityPoolInflow(receiver, activityPool) {
    if (receiver === activityPool)
        throw new Error("Activity pool cannot receive funds");
}
