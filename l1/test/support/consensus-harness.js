// Shared multi-validator harness for the F-01 tests (real NodeService, real
// fsynced SigningJournal and ChainStore files in temp directories, injected
// clocks, an in-memory transport with fault injection). It reuses the F-03
// approach: the target protocol version is reached through a real
// quorum-approved governance upgrade finalized at height 1 that activates at
// height 101, and the first 100 blocks are committed to every validator's store.
import assert from "node:assert/strict";
import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedValidator } from "../../src/block.js";
import { ZyronChain } from "../../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../../src/crypto.js";
import { NodeService } from "../../src/node.js";
import { ChainStore, SigningJournal } from "../../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval } from "../../src/transaction.js";
export const ACTIVATION_HEIGHT = 101;
export function testNetwork(n, firstKeyByte, chainId, genesisTimestampMs = 1_700_000_000_000) {
    const privateKeys = Array.from({ length: n }, (_, index) => (firstKeyByte + index).toString(16).padStart(64, "0"));
    const publicKeys = privateKeys.map(publicKeyFromPrivate);
    const oracle = publicKeyFromPrivate((firstKeyByte + 0x40).toString(16).padStart(64, "0"));
    const pool = addressFromPublicKey(publicKeyFromPrivate((firstKeyByte + 0x41).toString(16).padStart(64, "0")));
    return {
        chainId,
        privateKeys,
        publicKeys,
        genesis: {
            chainId,
            timestampMs: genesisTimestampMs,
            validators: publicKeys.map((publicKey) => ({ address: addressFromPublicKey(publicKey), publicKey })),
            activityOracles: [oracle],
            activityPool: pool,
            allocations: [{ address: pool, amountAtoms: 1_000_000 }]
        }
    };
}
const prefixCache = new Map();
/** Heights 1..100 finalized under v1, with protocolVersion active from height 101. */
export function finalizedPrefix(network, protocolVersion) {
    return finalizedPrefixSchedule(network, protocolVersion === 1 ? [] : [{ protocolVersion, activationHeight: ACTIVATION_HEIGHT }]);
}
/**
 * Heights 1..length finalized with the legacy rules of whatever version is
 * active, after quorum-approved upgrades (nonces 1, 2, ...) included at
 * heights 1, 2, ... that activate at the given heights.
 */
export function finalizedPrefixSchedule(network, upgrades, length = ACTIVATION_HEIGHT - 1) {
    const cacheKey = `${network.chainId}:${network.genesis.timestampMs}:${network.privateKeys.length}:${JSON.stringify(upgrades)}:${length}`;
    const cached = prefixCache.get(cacheKey);
    if (cached)
        return cached;
    const config = network.genesis;
    const chain = new ZyronChain(config);
    const upgradeTransactions = upgrades.map((upgrade, index) => {
        const proposal = {
            chainId: config.chainId,
            nonce: index + 1,
            sender: config.validators[0].address,
            activationHeight: upgrade.activationHeight,
            protocolVersion: upgrade.protocolVersion
        };
        return createProtocolUpgrade({
            ...proposal,
            approvals: network.privateKeys.map((key, keyIndex) => createProtocolUpgradeApproval(proposal, key, network.publicKeys[keyIndex])),
            timestampMs: config.timestampMs + 10 + index
        }, network.privateKeys[0], network.publicKeys[0]);
    });
    const blocks = [];
    for (let height = 1; height <= length; height += 1) {
        const timestampMs = config.timestampMs + (height * 1_000);
        const proposer = expectedValidator(config.validators, height, 0);
        const proposerKey = network.privateKeys[network.publicKeys.indexOf(proposer.publicKey)];
        const transactions = upgradeTransactions[height - 1] ? [upgradeTransactions[height - 1]] : [];
        let block = chain.produceBlock(transactions, proposerKey, { timestampMs });
        for (const key of network.privateKeys)
            block = chain.attestBlock(block, key);
        chain.acceptBlock(block, timestampMs);
        blocks.push(block);
    }
    for (const upgrade of upgrades)
        assert.equal(chain.protocolVersionAt(upgrade.activationHeight), upgrade.protocolVersion);
    prefixCache.set(cacheKey, blocks);
    return blocks;
}
// Committing 100 fsynced blocks takes ~1.5 s per validator, so the committed
// store (without any signing journal) is built once per prefix and copied.
const templateCache = new Map();
const templateDirectories = [];
process.once("exit", () => {
    // Best effort; temp directories are small.
    for (const directory of templateDirectories)
        void rm(directory, { recursive: true, force: true });
});
async function storeTemplate(network, prefix) {
    let template = templateCache.get(prefix);
    if (!template) {
        template = (async () => {
            const directory = await mkdtemp(join(tmpdir(), "zyron-f01-template-"));
            templateDirectories.push(directory);
            const store = await ChainStore.open(network.genesis, directory);
            for (const block of prefix)
                await store.commitFinalizedBlock(block);
            return directory;
        })();
        templateCache.set(prefix, template);
    }
    return template;
}
export async function openValidator(network, index, prefix, directory) {
    let dir = directory;
    if (!dir) {
        dir = await mkdtemp(join(tmpdir(), `zyron-f01-v${index}-`));
        if (prefix.length > 0) {
            const template = await storeTemplate(network, prefix);
            for (const name of await readdir(template)) {
                if (name.startsWith("signing-journal"))
                    continue;
                await cp(join(template, name), join(dir, name), { recursive: true });
            }
        }
    }
    const store = await ChainStore.open(network.genesis, dir);
    for (const block of prefix)
        if (block.header.height > store.chain.height)
            await store.commitFinalizedBlock(block);
    assert.ok(store.chain.height >= prefix.length, "validator store does not contain the finalized prefix");
    const journal = await SigningJournal.open(dir);
    const service = new NodeService(store, journal, network.privateKeys[index]);
    return { index, directory: dir, journal, service };
}
export async function closeValidators(validators, remove = true) {
    for (const validator of validators) {
        if (!validator)
            continue;
        validator.journal.close();
        if (remove)
            await rm(validator.directory, { recursive: true, force: true });
    }
}
export function proposerIndex(network, height, round) {
    return network.publicKeys.indexOf(expectedValidator(network.genesis.validators, height, round).publicKey);
}
/** Legacy journal rows as "height:round=kind" for assertions and reports. */
export async function journalRows(validator) {
    let text = "";
    try {
        text = await readFile(join(validator.directory, "signing-journal.ndjson"), "utf8");
    }
    catch {
        return [];
    }
    return text.split("\n").filter(Boolean).map((line) => {
        const row = JSON.parse(line);
        return row.kind !== undefined
            ? `${String(row.height)}:${String(row.round)}=${String(row.kind)}`
            : `${String(row.height)}:${String(row.round)}=${String(row.step)}`;
    });
}
/**
 * In-memory consensus transport between validators of one process. Each
 * request calls the remote NodeService handler directly (as the HTTP and
 * native servers do) unless the destination is offline or the link drops it.
 */
export class MemoryNetwork {
    validators;
    clock;
    online;
    /** Return true to drop a request from -> to of the given kind. */
    drop = () => false;
    /** Awaited before a request is delivered (used to interleave actions deterministically). */
    beforeDeliver = () => { };
    errors = [];
    /** v6 requests as sent (prepare/commit), for replay in fault-point tests. */
    captured = [];
    constructor(validators, clock) {
        this.validators = validators;
        this.clock = clock;
        this.online = validators.map((validator) => validator !== undefined);
    }
    reachable(from, to, kind) {
        const target = this.validators[to];
        if (from === to || !target || !this.online[to] || this.drop(from, to, kind))
            return undefined;
        return target;
    }
    async deliver(from, kind, call) {
        const results = [];
        for (let to = 0; to < this.validators.length; to += 1) {
            if (!this.reachable(from, to, kind))
                continue;
            await this.beforeDeliver(from, to, kind);
            const target = this.reachable(from, to, kind);
            if (!target)
                continue;
            try {
                results.push(await call(target));
            }
            catch (error) {
                this.errors.push({ from, to, kind, message: error instanceof Error ? error.message : String(error) });
            }
        }
        return results;
    }
    peersFor(from) {
        return {
            requestAttestations: (block) => this.deliver(from, "attest", (target) => target.service.attestProposal(block, this.clock())),
            requestRoundSkips: (height, round, previousCertificate) => this.deliver(from, "skip", (target) => target.service.requestSkipVote(height, round, previousCertificate ?? [], this.clock())),
            broadcastBlock: async (block) => {
                await this.deliver(from, "block", (target) => target.service.acceptFinalizedBlock(block));
            },
            requestV6Prepare: (request) => (this.captured.push({ from, kind: "v6-prepare", request: structuredClone(request) }), this.deliver(from, "v6-prepare", (target) => target.service.v6Prepare(structuredClone(request), this.clockFor(target.index)))),
            requestV6Commit: (request) => (this.captured.push({ from, kind: "v6-commit", request: structuredClone(request) }), this.deliver(from, "v6-commit", (target) => target.service.v6Commit(structuredClone(request), this.clockFor(target.index)))),
            requestV6Timeouts: (height, round) => this.deliver(from, "v6-timeout", (target) => target.service.v6Timeout(height, round, this.clockFor(target.index))),
            fetchV6Block: async (height, blockHash) => {
                const found = await this.deliver(from, "v6-block", async (target) => target.service.v6FetchBlock(height, blockHash));
                return found.find((block) => block !== null) ?? null;
            }
        };
    }
    /** Per-validator clock offsets (clock skew, T8). */
    skewMs = new Map();
    clockFor(index) {
        return this.clock() + (this.skewMs.get(index) ?? 0);
    }
}
