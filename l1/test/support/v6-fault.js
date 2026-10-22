// P0-03: deterministic protocol-v6 fault-injection harness.
//
// Builds on V6Sim (real NodeService, real fsynced SigningJournal and
// consensus-state files, the production V6LeaderScheduler, virtual time) and
// adds, without touching any consensus code:
//   - CrashInjector: process crash at a chosen handler step (block-proposal,
//     proposal, prepare, commit, timeout) and point (consensus-state write
//     before/after rename, journal append before/after fsync, after the
//     signature), with simulated power loss (unflushed journal bytes lost or
//     torn, an unsynced rename lost);
//   - JournalAudit: every v2 journal row any honest validator ever made
//     durable, checked for double-signs, lock regressions, mixed legacy/v6
//     heights, and cross-checked against every signature seen on the wire
//     (a signature without a durable journal row is a violation);
//   - network faults: flapping symmetric/asymmetric partitions, per-message
//     delay (late delivery after the leader gave up), duplication and replay
//     of old requests (reordering), validator disconnect/reconnect;
//   - up to f byzantine validators that equivocate as leaders (twin with a
//     separate journal) and sign any prepare/commit request as voters;
//   - prolonged outage then block sync, long runs, and a v5 -> v6 activation
//     with late nodes.
// Invariants checked on every run: no two honest validators finalize
// different blocks at a height, no two commit certificates for one height,
// no honest double-sign (wire ledger and journal audit), every honest
// finalized chain is prefix-consistent (hash links), liveness within the
// spec bound after GST when at most f validators are faulty, and the supply
// invariant (total supply = initial supply - burned fees, never above it).
// Every random choice derives from the seed, so a run is reproducible.
import { existsSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validatorQuorumSize } from "../../src/block.js";
import { V6_COMMIT_VOTE_DOMAIN, V6_PREPARE_VOTE_DOMAIN, V6_ROUND_BASE_MS, isConsensusV6, proposalDigest, signV6, votePayload } from "../../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../../src/crypto.js";
import { createTransfer } from "../../src/transaction.js";
import { v6LeaderStart } from "../../src/v6-scheduler.js";
import { ACTIVATION_HEIGHT, closeValidators, finalizedPrefix, finalizedPrefixSchedule, openValidator, testNetwork } from "./consensus-harness.js";
import { V6Sim, seededRandom } from "./v6-sim.js";
// ---------------------------------------------------------------------------
// Crash and power-loss injection
// ---------------------------------------------------------------------------
export const HANDLER_STEPS = ["block-proposal", "proposal", "prepare", "commit", "timeout"];
/**
 * Where inside a handler the process dies.
 * - state-before-rename: consensus-state temp file fsynced, not renamed (temp file left behind);
 * - state-rename-lost: renamed but the directory was not fsynced and power was lost (old file back);
 * - journal-unsynced-survive: journal row written, not fsynced, the bytes survive (process crash);
 * - journal-unsynced-lost: same, power loss drops the unflushed bytes;
 * - journal-unsynced-torn: same, power loss leaves a prefix of the appended bytes;
 * - journal-synced: the row is durable, the signature never left;
 * - after-sign: the handler returned its signature, the reply is lost.
 */
export const CRASH_POINTS = [
    "state-before-rename",
    "state-rename-lost",
    "journal-unsynced-survive",
    "journal-unsynced-lost",
    "journal-unsynced-torn",
    "journal-synced",
    "after-sign"
];
/** Points a plain process crash can produce (no lost or torn bytes). */
export const PROCESS_CRASH_POINTS = ["state-before-rename", "journal-unsynced-survive", "journal-synced", "after-sign"];
/** Points that need a power loss (unflushed data lost). */
export const POWER_LOSS_POINTS = ["state-rename-lost", "journal-unsynced-lost", "journal-unsynced-torn", "journal-unsynced-survive"];
const HANDLER_METHODS = [
    ["v6SignFreshBlock", "block-proposal"],
    ["v6SignProposal", "proposal"],
    ["v6Prepare", "prepare"],
    ["v6Commit", "commit"],
    ["v6Timeout", "timeout"]
];
export class CrashInjector {
    now;
    onCrash;
    allowLockRowOnly;
    events = [];
    armedCount = new Map();
    /** Validators whose journal holds a complete lock row without its commit row (reopen fail-stops, spec T10). */
    lockRowOnly = new Set();
    arms = new Map();
    dead = new WeakSet();
    /**
     * @param onCrash called synchronously when a crash fires (mark the validator offline there)
     * @param allowLockRowOnly whether a power loss may leave a complete lock row without any byte of
     *   its commit row at validator `index` (the journal then fail-stops on reopen and the validator
     *   counts as faulty); otherwise such a cut is moved into the lock row
     */
    constructor(now, onCrash, allowLockRowOnly = () => true) {
        this.now = now;
        this.onCrash = onCrash;
        this.allowLockRowOnly = allowLockRowOnly;
    }
    arm(index, arm) {
        this.arms.set(index, arm);
        const key = `${arm.step}/${arm.point}`;
        this.armedCount.set(key, (this.armedCount.get(key) ?? 0) + 1);
    }
    armed(index) { return this.arms.get(index); }
    disarm(index) { this.arms.delete(index); }
    disarmAll() { this.arms.clear(); }
    /** Patch one validator instance (call again for every reopened instance). */
    instrument(index, validator) {
        const service = validator.service;
        const journal = validator.journal;
        const state = validator.journal.consensusState;
        const journalPath = join(validator.directory, "signing-journal.ndjson");
        let handler = null;
        const alive = () => {
            if (this.dead.has(validator))
                throw new Error("simulated crash: validator process is down");
        };
        const fire = (point, detail) => {
            const arm = this.arms.get(index);
            this.arms.delete(index);
            this.dead.add(validator);
            const event = { index, atMs: this.now(), step: arm.step, point, height: validator.service.store.chain.height + 1, detail };
            this.events.push(event);
            this.onCrash(index, event);
            throw new Error(`simulated crash at ${arm.step}/${point}`);
        };
        for (const [name, step] of HANDLER_METHODS) {
            const original = service[name].bind(service);
            service[name] = async (...args) => {
                alive();
                handler = step;
                try {
                    const result = await original(...args);
                    alive();
                    const arm = this.arms.get(index);
                    if (arm && arm.step === step && arm.point === "after-sign")
                        fire("after-sign", "signature produced, reply lost");
                    return result;
                }
                finally {
                    handler = null;
                }
            };
        }
        const powerLoss = (before, arm) => {
            if (arm.point === "journal-unsynced-survive")
                return "unflushed bytes survived";
            if (arm.point === "journal-unsynced-lost") {
                truncateSync(journalPath, before);
                return "unflushed bytes lost";
            }
            const bytes = readFileSync(journalPath).subarray(before);
            const firstRow = bytes.indexOf(0x0a) + 1;
            const twoRows = firstRow > 0 && firstRow < bytes.length;
            let keep = arm.cut === "lock-row" && twoRows ? firstRow : 1 + Math.floor((arm.cut === "lock-row" ? 0.5 : arm.cut) * Math.max(0, bytes.length - 1));
            keep = Math.max(1, Math.min(keep, bytes.length - 1));
            // A complete lock row (with or without its newline) and no commit byte: the journal fail-stops on reopen.
            let lockOnly = twoRows && (keep === firstRow || keep === firstRow - 1);
            if (lockOnly && !this.allowLockRowOnly(index)) {
                keep = Math.max(1, firstRow - 2);
                lockOnly = false;
            }
            if (lockOnly)
                this.lockRowOnly.add(index);
            truncateSync(journalPath, before + keep);
            const where = !twoRows ? "single row" : lockOnly ? "lock row persisted without its commit row" : keep > firstRow ? "torn inside the commit row" : "torn inside the lock row";
            return `torn write kept ${keep}/${bytes.length} bytes (${where})`;
        };
        const wrapReserve = (name, stepOf, hooksIndex) => {
            const original = journal[name].bind(journal);
            journal[name] = async (...args) => {
                alive();
                const step = stepOf(args);
                const arm = this.arms.get(index);
                if (!arm || arm.step !== step || !arm.point.startsWith("journal-"))
                    return original(...args);
                const before = statSync(journalPath).size;
                const hooks = arm.point === "journal-synced"
                    ? { afterSync: () => fire(arm.point, "journal row durable, signature not released") }
                    : { afterWrite: () => fire(arm.point, powerLoss(before, arm)) };
                const callArgs = [...args];
                while (callArgs.length < hooksIndex)
                    callArgs.push(undefined);
                callArgs[hooksIndex] = hooks;
                return original(...callArgs);
            };
        };
        wrapReserve("reserveV6", (args) => args[2], 4);
        wrapReserve("reserveV6Prepare", () => "prepare", 4);
        wrapReserve("reserveV6Commit", () => "commit", 3);
        const originalWrite = state.write.bind(state);
        state.write = async (...args) => {
            alive();
            const [name, value] = args;
            const arm = this.arms.get(index);
            if (!arm || handler !== arm.step || !arm.point.startsWith("state-"))
                return originalWrite(...args);
            const target = join(state.directory, name);
            if (arm.point === "state-before-rename") {
                return originalWrite(name, value, {
                    afterTemporarySync: () => {
                        // A real crash leaves the temporary file behind (here: a truncated one).
                        writeFileSync(`${target}.tmp-crash-${index}`, JSON.stringify(value).slice(0, 17));
                        fire(arm.point, `${name}: temporary file fsynced, not renamed`);
                    }
                });
            }
            const previous = existsSync(target) ? readFileSync(target) : null;
            return originalWrite(name, value, {
                afterRename: () => {
                    if (previous)
                        writeFileSync(target, previous);
                    else
                        unlinkSync(target);
                    fire(arm.point, `${name}: rename lost by power loss (${previous ? "old version back" : "file absent"})`);
                }
            });
        };
    }
}
export class JournalAudit {
    /** index -> `${H}|${r}|${step}` -> values */
    rows = new Map();
    legacyHeights = new Map();
    v6Heights = new Map();
    violations = [];
    lastLock = new Map();
    rowsSeen = 0;
    attach(index, validator) {
        this.scan(index, join(validator.directory, "signing-journal.ndjson"));
        const journal = validator.journal;
        const original = journal.appendV6.bind(journal);
        journal.appendV6 = async (...args) => {
            const result = await original(...args);
            for (const row of args[0])
                this.record(index, row, true);
            return result;
        };
    }
    scan(index, path) {
        let text = "";
        try {
            text = readFileSync(path, "utf8");
        }
        catch {
            return;
        }
        for (const line of text.split("\n").slice(0, -1)) {
            if (!line.trim())
                continue;
            let row;
            try {
                row = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (row.v === 2)
                this.record(index, row, false);
            else if (row.kind === "attest" || row.kind === "skip")
                this.note(this.legacyHeights, index, row.height);
        }
    }
    note(map, index, height) {
        let set = map.get(index);
        if (!set) {
            set = new Set();
            map.set(index, set);
        }
        set.add(height);
    }
    record(index, row, live) {
        this.rowsSeen += 1;
        this.note(this.v6Heights, index, row.height);
        let rows = this.rows.get(index);
        if (!rows) {
            rows = new Map();
            this.rows.set(index, rows);
        }
        const key = `${row.height}|${row.round}|${row.step}`;
        let values = rows.get(key);
        if (!values) {
            values = new Set();
            rows.set(key, values);
        }
        values.add(row.value);
        if (values.size > 1)
            this.violations.push(`v${index} journal double-sign ${key}: ${[...values].join(",")}`);
        if (row.step === "commit") {
            const prepared = rows.get(`${row.height}|${row.round}|prepare`);
            if (prepared && !prepared.has(row.value))
                this.violations.push(`v${index} commit differs from own prepare at ${row.height}/${row.round}`);
        }
        if (row.step === "lock" && live) {
            const lockKey = `${index}|${row.height}`;
            const last = this.lastLock.get(lockKey);
            if (last && (row.round < last.round || (row.round === last.round && row.value !== last.value))) {
                this.violations.push(`v${index} lock regression at ${row.height}: ${last.round}:${last.value.slice(0, 8)} -> ${row.round}:${row.value.slice(0, 8)}`);
            }
            this.lastLock.set(lockKey, { round: row.round, value: row.value });
        }
    }
    has(index, height, round, step, value) {
        return this.rows.get(index)?.get(`${height}|${round}|${step}`)?.has(value) ?? false;
    }
    /** Heights with both legacy and v2 rows, per validator. */
    mixedHeights() {
        const result = [];
        for (const [index, legacy] of this.legacyHeights) {
            for (const height of legacy)
                if (this.v6Heights.get(index)?.has(height))
                    result.push(`v${index}@${height}`);
        }
        return result;
    }
}
// ---------------------------------------------------------------------------
// Byzantine voters
// ---------------------------------------------------------------------------
/** Make `validator` sign every prepare/commit request it receives (no journal, no lock): an equivocating voter. */
export function makeEquivocatingVoter(network, validator) {
    const key = network.privateKeys[validator.index];
    const publicKey = network.publicKeys[validator.index];
    const address = addressFromPublicKey(publicKey);
    const service = validator.service;
    service.v6Prepare = async (value) => {
        const request = value;
        return { validator: address, publicKey, signature: signV6(V6_PREPARE_VOTE_DOMAIN, votePayload(network.chainId, request.proposal.height, request.proposal.round, request.block.hash), key) };
    };
    service.v6Commit = async (value) => {
        const request = value;
        return { validator: address, publicKey, signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(network.chainId, request.qc.height, request.qc.round, request.qc.blockHash), key) };
    };
}
// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------
export const FAULT_SCENARIOS = [
    "crash-step",
    "power-loss",
    "partition-flapping",
    "delay-reorder-duplicate",
    "disconnect-reconnect",
    "prolonged-outage-sync",
    "byzantine-f",
    "long-run",
    "upgrade-v5-v6",
    "combined"
];
const DEFAULT_CHAOS_MS = {
    "crash-step": 300_000,
    "power-loss": 300_000,
    "partition-flapping": 240_000,
    "delay-reorder-duplicate": 240_000,
    "disconnect-reconnect": 300_000,
    "prolonged-outage-sync": 600_000,
    "byzantine-f": 240_000,
    "long-run": 1_200_000,
    "upgrade-v5-v6": 240_000,
    combined: 360_000
};
export const UPGRADE_ACTIVATION_HEIGHT = 110;
function sample(random, items) {
    return items[Math.floor(random() * items.length)];
}
function sampleSet(random, n, count, exclude = new Set()) {
    const pool = Array.from({ length: n }, (_, index) => index).filter((index) => !exclude.has(index));
    const chosen = [];
    while (chosen.length < count && pool.length)
        chosen.push(pool.splice(Math.floor(random() * pool.length), 1)[0]);
    return chosen.sort((a, b) => a - b);
}
export async function runFault(options) {
    const { scenario, n, seed } = options;
    const chaosMs = options.chaosMs ?? DEFAULT_CHAOS_MS[scenario];
    const postGstHeights = options.postGstHeights ?? (scenario === "long-run" ? 10 : 4);
    const f = n - validatorQuorumSize(n);
    const upgrade = scenario === "upgrade-v5-v6";
    const firstKeyByte = 0x60 + n;
    const network = testNetwork(n, firstKeyByte, `zyron-v6fault-${upgrade ? "upgrade" : "v6"}-n${n}`);
    const fullPrefix = upgrade
        ? finalizedPrefixSchedule(network, [
            { protocolVersion: 5, activationHeight: ACTIVATION_HEIGHT },
            { protocolVersion: 6, activationHeight: UPGRADE_ACTIVATION_HEIGHT }
        ], UPGRADE_ACTIVATION_HEIGHT - 1)
        : finalizedPrefix(network, 6);
    const activationHeight = upgrade ? UPGRADE_ACTIVATION_HEIGHT : ACTIVATION_HEIGHT;
    // Fault-process randomness, independent of the simulator's own stream.
    const random = seededRandom((seed * 0x9e3779b1 + n * 0x85ebca6b + FAULT_SCENARIOS.indexOf(scenario) * 0xc2b2ae35) >>> 0);
    const chance = (p) => random() < p;
    // ---- fault roles -------------------------------------------------------
    const byzantineCount = scenario === "byzantine-f" ? f : scenario === "combined" ? Math.min(1, f) : 0;
    const byzantineIndexes = sampleSet(random, n, byzantineCount);
    const byzantineSet = new Set(byzantineIndexes);
    const late = new Map(); // index -> legacy blocks missing at start
    if (upgrade)
        for (const index of sampleSet(random, n, Math.max(1, f)))
            late.set(index, 1 + Math.floor(random() * 6));
    const outage = scenario === "prolonged-outage-sync" ? sampleSet(random, n, Math.max(1, f), byzantineSet) : [];
    const validators = [];
    for (let index = 0; index < n; index += 1) {
        const missing = late.get(index) ?? 0;
        validators.push(await openValidator(network, index, missing ? fullPrefix.slice(0, fullPrefix.length - missing) : fullPrefix));
    }
    const byzantines = [];
    for (const index of byzantineIndexes) {
        const others = validators.map((_, item) => item).filter((item) => item !== index);
        let sideA = new Set(others.filter(() => random() < 0.5));
        if (sideA.size === 0 || sideA.size === others.length)
            sideA = new Set(others.slice(0, Math.ceil(others.length / 2)));
        byzantines.push({ index, twin: await openValidator(network, index, fullPrefix), sideA });
    }
    const startTip = Math.max(...validators.map((validator) => validator.service.store.chain.tip.header.timestampMs));
    const firstHeight = fullPrefix.length + 1;
    const initialSupply = validators[0].service.store.chain.totalSupplyAtoms();
    const sim = new V6Sim({ network, prefix: fullPrefix, validators, seed, startMs: startTip, byzantines });
    for (const index of byzantineIndexes)
        makeEquivocatingVoter(network, validators[index]);
    const gst = startTip + V6_ROUND_BASE_MS + chaosMs;
    const honest = validators.map((_, index) => index).filter((index) => !byzantineSet.has(index));
    const crashed = new Set();
    const permanent = new Set();
    const failStops = [];
    const counters = { idleCrashes: 0, delayed: 0, duplicated: 0, replayed: 0, lateResponses: 0, linkChanges: 0, disconnects: 0, lateJoins: 0, restartsWhileLocked: 0, transfersSubmitted: 0 };
    const audit = new JournalAudit();
    const injector = new CrashInjector(() => sim.time.nowMs, (index) => {
        crashed.add(index);
        sim.crash(index);
        scheduleRestart(index);
    }, (index) => new Set([...permanent, ...injector.lockRowOnly, index]).size + byzantineCount <= f);
    const instrument = (index, validator) => {
        if (byzantineSet.has(index))
            return;
        audit.attach(index, validator);
        injector.instrument(index, validator);
    };
    validators.forEach((validator, index) => instrument(index, validator));
    sim.onReopen = instrument;
    const result = {
        scenario, n, f, seed, faulty: "none", byzantine: byzantineIndexes, permanentFaulty: [], failStops,
        heightsFinalized: 0, heightsBeforeGst: 0, heightsAfterGst: 0, rStar: 0, postGst: [], livenessAsserted: false, livenessOk: false,
        crashes: [], idleCrashes: 0, restarts: 0, restartsWhileLocked: 0, delayed: 0, duplicated: 0, replayed: 0, lateResponses: 0,
        linkChanges: 0, disconnects: 0, lateJoins: 0, transfersSubmitted: 0, transfersFinalized: 0,
        supply: { initial: initialSupply, final: [], burnedFees: [], ok: false },
        signaturesSeen: 0, journalRows: 0, honestDoubleSigns: 0, byzantineDoubleSigns: 0, journalViolations: [], unjournaledSignatures: [],
        conflictingCertificates: 0, conflictingFinality: 0, prefixViolations: [], upgradeViolations: [], ok: false
    };
    async function restartNow(index) {
        if (permanent.has(index))
            return;
        crashed.delete(index);
        const height = sim.validators[index].service.store.chain.height + 1;
        if (sim.validators[index].journal.v6Lock(height))
            counters.restartsWhileLocked += 1;
        try {
            await sim.restart(index);
        }
        catch (error) {
            // Reopen refused (e.g. a torn lock/commit pair, spec T10): fail-stop, the validator is now faulty.
            crashed.add(index);
            permanent.add(index);
            sim.crash(index);
            failStops.push(`v${index}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    function scheduleRestart(index) {
        sim.time.setTimeout(async () => {
            if (!crashed.has(index) || permanent.has(index) || sim.time.nowMs >= gst || outage.includes(index))
                return;
            await restartNow(index);
        }, 5_000 + Math.floor(random() * 55_000));
    }
    const every = (minMs, maxMs, action) => {
        const loop = async () => {
            if (sim.time.nowMs >= gst)
                return;
            await action();
            sim.time.setTimeout(loop, minMs + Math.floor(random() * (maxMs - minMs)));
        };
        sim.time.setTimeout(loop, minMs + Math.floor(random() * (maxMs - minMs)));
    };
    const crashable = () => honest.filter((index) => !crashed.has(index) && !permanent.has(index) && !late.has(index) && !outage.includes(index));
    const armRandomCrash = (points) => {
        const candidates = crashable().filter((index) => !injector.armed(index));
        if (!candidates.length)
            return;
        const steps = options.steps ?? HANDLER_STEPS;
        injector.arm(sample(random, candidates), { step: sample(random, steps), point: sample(random, options.points ?? points), cut: options.cut ?? random() });
    };
    const armCover = () => {
        const cover = options.cover;
        const fired = new Set(injector.events.filter((event) => event.point === cover.point).map((event) => event.step));
        const pending = cover.steps.filter((step) => !fired.has(step));
        if (!pending.length)
            return;
        const candidates = crashable().filter((index) => !injector.armed(index));
        if (!candidates.length)
            return;
        injector.arm(sample(random, candidates), { step: sample(random, pending), point: cover.point, cut: options.cut ?? random() });
    };
    const idleCrash = () => {
        const candidates = crashable();
        if (!candidates.length)
            return;
        const index = sample(random, candidates);
        injector.disarm(index);
        counters.idleCrashes += 1;
        crashed.add(index);
        sim.crash(index);
        scheduleRestart(index);
    };
    // ---- link faults -------------------------------------------------------
    let linkFilter = () => false;
    let dropRate = 0;
    const disconnected = new Map();
    const symmetric = () => {
        const groupA = new Set(validators.map((_, index) => index).filter(() => chance(0.5)));
        linkFilter = (from, to) => groupA.has(from) !== groupA.has(to);
    };
    const asymmetric = () => {
        const down = new Set();
        for (let a = 0; a < n; a += 1)
            for (let b = 0; b < n; b += 1)
                if (a !== b && chance(0.5))
                    down.add(`${a}>${b}`);
        linkFilter = (from, to) => down.has(`${from}>${to}`);
    };
    const flap = () => {
        counters.linkChanges += 1;
        const roll = random();
        if (roll < 0.3)
            linkFilter = () => false;
        else if (roll < 0.65)
            symmetric();
        else
            asymmetric();
    };
    const disconnect = () => {
        const candidates = honest.filter((index) => !(disconnected.get(index) > sim.time.nowMs));
        if (!candidates.length)
            return;
        counters.disconnects += 1;
        disconnected.set(sample(random, candidates), sim.time.nowMs + 5_000 + Math.floor(random() * 85_000));
    };
    sim.linkDown = (from, to, kind, nowMs) => {
        if (crashed.has(from) || crashed.has(to))
            return true;
        if (nowMs >= gst)
            return false;
        if ((disconnected.get(from) ?? 0) > nowMs || (disconnected.get(to) ?? 0) > nowMs)
            return true;
        return linkFilter(from, to, kind) || (dropRate > 0 && kind !== "sync" && sim.random() < dropRate);
    };
    // ---- message delay, duplication and replay ------------------------------
    let delivery;
    const memory = sim.memory;
    const originalDeliver = memory.deliver.bind(sim.memory);
    const recordLate = (kind, request, response) => {
        counters.lateResponses += 1;
        if (kind === "v6-prepare")
            sim.ledger.prepareResponses(request, [response]);
        else if (kind === "v6-commit")
            sim.ledger.commitRequest(request, [response]);
        else if (kind === "v6-timeout") {
            const vote = response.vote;
            sim.ledger.timeout(response, vote.height, vote.round);
        }
    };
    const lateCall = (from, to, kind, request, call, delayMs) => {
        sim.time.setTimeout(async () => {
            const target = sim.memory.reachable(from, to, kind);
            if (!target)
                return;
            try {
                recordLate(kind, request, await call(target));
            }
            catch { /* refused: fine */ }
        }, delayMs);
    };
    memory.deliver = async (from, kind, call) => {
        if (!delivery || sim.time.nowMs >= gst || !kind.startsWith("v6-") || kind === "v6-block")
            return originalDeliver(from, kind, call);
        const captured = sim.memory.captured.at(-1);
        const request = kind === "v6-prepare" || kind === "v6-commit" ? captured?.request : undefined;
        const results = [];
        for (let to = 0; to < n; to += 1) {
            if (!sim.memory.reachable(from, to, kind))
                continue;
            if (chance(delivery.delay)) {
                counters.delayed += 1;
                lateCall(from, to, kind, request, call, 500 + Math.floor(random() * 45_000));
                continue;
            }
            const target = sim.memory.reachable(from, to, kind);
            try {
                results.push(await call(target));
            }
            catch { /* refused */ }
            if (chance(delivery.duplicate)) {
                counters.duplicated += 1;
                lateCall(from, to, kind, request, call, Math.floor(random() * 20_000));
            }
        }
        return results;
    };
    const replayOld = async () => {
        const captured = sim.memory.captured;
        if (!captured.length)
            return;
        const item = captured[Math.floor(random() * captured.length)];
        const to = sample(random, honest);
        if (crashed.has(to))
            return;
        const target = sim.validators[to];
        counters.replayed += 1;
        try {
            if (item.kind === "v6-prepare")
                recordLate("v6-prepare", item.request, await target.service.v6Prepare(structuredClone(item.request), sim.memory.clockFor(to)));
            else if (item.kind === "v6-commit")
                recordLate("v6-commit", item.request, await target.service.v6Commit(structuredClone(item.request), sim.memory.clockFor(to)));
        }
        catch { /* stale or conflicting: refused */ }
    };
    // ---- transactions (supply invariant) ------------------------------------
    const poolKey = (firstKeyByte + 0x41).toString(16).padStart(64, "0");
    const poolPublicKey = publicKeyFromPrivate(poolKey);
    const poolAddress = addressFromPublicKey(poolPublicKey);
    const receiver = addressFromPublicKey(publicKeyFromPrivate((firstKeyByte + 0x42).toString(16).padStart(64, "0")));
    let lastNonce = 0;
    const submitTransfer = () => {
        const online = honest.filter((index) => !crashed.has(index) && sim.memory.online[index]);
        if (!online.length)
            return;
        const nonce = Math.max(...online.map((index) => sim.validators[index].service.store.chain.nonce(poolAddress))) + 1;
        if (nonce <= lastNonce)
            return;
        const chain = sim.validators[online[0]].service.store.chain;
        const version = chain.protocolVersionAt(chain.height + 1) >= 3 ? 2 : 1;
        const tx = createTransfer({ chainId: network.chainId, nonce, sender: poolAddress, receiver, amountAtoms: 100 + Math.floor(random() * 900), feeAtoms: 1 + Math.floor(random() * 20), timestampMs: sim.time.nowMs }, poolKey, poolPublicKey, version);
        let accepted = false;
        for (const index of online) {
            try {
                sim.validators[index].service.submitTransaction(structuredClone(tx));
                accepted = true;
            }
            catch { /* not admissible there */ }
        }
        if (accepted) {
            lastNonce = nonce;
            counters.transfersSubmitted += 1;
        }
    };
    try {
        // ---- start -------------------------------------------------------------
        for (let index = 0; index < n; index += 1) {
            if (late.has(index)) {
                sim.crash(index);
                continue;
            }
            sim.startAt(index, startTip + Math.floor(random() * V6_ROUND_BASE_MS));
        }
        const join = async (index) => {
            if (!late.has(index) || sim.memory.online[index])
                return;
            counters.lateJoins += 1;
            sim.memory.online[index] = true;
            sim.startAt(index, sim.time.nowMs);
            await sim.syncAll();
        };
        every(20_000, 45_000, submitTransfer);
        // ---- scenario fault process before GST -----------------------------------
        if (options.selfTest === "honest-voter-without-journal")
            makeEquivocatingVoter(network, validators[honest[0]]);
        if (options.selfTest === "supply-skew") {
            const chain = validators[honest[0]].service.store.chain;
            const original = chain.totalSupplyAtoms.bind(chain);
            chain.totalSupplyAtoms = () => original() + 1;
        }
        switch (options.cover ? "cover" : scenario) {
            case "cover":
                dropRate = 0.15;
                every(3_000, 8_000, armCover);
                break;
            case "crash-step":
                dropRate = 0.1;
                every(10_000, 40_000, () => armRandomCrash(PROCESS_CRASH_POINTS));
                every(60_000, 150_000, idleCrash);
                break;
            case "power-loss":
                dropRate = 0.1;
                every(10_000, 40_000, () => armRandomCrash(POWER_LOSS_POINTS));
                every(60_000, 150_000, idleCrash);
                break;
            case "partition-flapping":
                every(500, 5_000, flap);
                break;
            case "delay-reorder-duplicate":
                delivery = { delay: 0.25, duplicate: 0.2, replay: 0 };
                every(2_000, 10_000, replayOld);
                break;
            case "disconnect-reconnect":
                every(5_000, 30_000, disconnect);
                break;
            case "prolonged-outage-sync":
                dropRate = 0.05;
                for (const index of outage) {
                    sim.time.setTimeout(() => { crashed.add(index); sim.crash(index); }, V6_ROUND_BASE_MS + Math.floor(random() * 30_000));
                }
                break;
            case "byzantine-f":
                dropRate = 0.1;
                break;
            case "long-run":
                dropRate = 0.05;
                every(120_000, 300_000, () => armRandomCrash(PROCESS_CRASH_POINTS));
                break;
            case "upgrade-v5-v6":
                dropRate = 0.05;
                for (const index of late.keys()) {
                    const at = 30_000 + Math.floor(random() * chaosMs);
                    if (at < chaosMs)
                        sim.time.setTimeout(() => join(index), at);
                }
                break;
            case "combined":
                dropRate = 0.05;
                delivery = { delay: 0.1, duplicate: 0.1, replay: 0 };
                every(5_000, 30_000, flap);
                every(5_000, 20_000, replayOld);
                every(20_000, 60_000, disconnect);
                every(15_000, 45_000, () => armRandomCrash(chance(0.5) ? PROCESS_CRASH_POINTS : POWER_LOSS_POINTS));
                every(90_000, 200_000, idleCrash);
                break;
        }
        await sim.run(gst);
        // ---- GST: heal, restart crashed (non-permanent), late nodes join ---------
        linkFilter = () => false;
        dropRate = 0;
        delivery = undefined;
        disconnected.clear();
        injector.disarmAll();
        for (const index of [...crashed])
            if (!permanent.has(index) && !late.has(index))
                await restartNow(index);
        for (const index of late.keys())
            await join(index);
        await sim.syncAll();
        const fFaulty = byzantineCount + permanent.size;
        const online = honest.filter((index) => !permanent.has(index));
        const heightAtGst = Math.max(...online.map((index) => sim.height(index)));
        result.heightsBeforeGst = heightAtGst - firstHeight + 1;
        const reference = sim.validators[online[0]];
        let rStar = 0;
        const gstTip = reference.service.store.chain.tip.header.timestampMs;
        while (v6LeaderStart(gstTip, rStar) < gst)
            rStar += 1;
        result.rStar = rStar;
        const target = heightAtGst + postGstHeights;
        await sim.run(gst + 3_600_000 + postGstHeights * 600_000, () => online.every((index) => sim.height(index) >= target));
        sim.stopAll();
        await sim.syncAll();
        // ---- assertions ------------------------------------------------------------
        const failures = [];
        const finalityByHeight = new Map(sim.finality.map((item) => [item.height, item]));
        result.heightsFinalized = sim.maxHeight() - firstHeight + 1;
        result.heightsAfterGst = sim.maxHeight() - heightAtGst;
        let pendingSince = gst;
        for (let height = heightAtGst + 1; height <= target; height += 1) {
            const item = finalityByHeight.get(height);
            const [previous] = await reference.service.store.readFinalizedBlocks(height - 1, 1, 8_000_000);
            if (!item || !previous) {
                result.postGst.push({ height, commitRound: -1, bound: -1, latencyMs: -1 });
                break;
            }
            let first = 0;
            while (v6LeaderStart(previous.header.timestampMs, first) < pendingSince)
                first += 1;
            result.postGst.push({ height, commitRound: item.commitRound, bound: first + fFaulty, latencyMs: item.atMs - pendingSince });
            pendingSince = Math.max(gst, item.atMs);
        }
        result.livenessAsserted = fFaulty <= f;
        result.livenessOk = online.every((index) => sim.height(index) >= target) && result.postGst.length === postGstHeights &&
            result.postGst.every((item) => item.commitRound >= 0 && item.commitRound <= item.bound);
        if (result.livenessAsserted && !result.livenessOk) {
            failures.push(`liveness after GST (R*=${rStar}, faulty=${fFaulty}): ${JSON.stringify(result.postGst)}, heights ${online.map((index) => sim.height(index)).join("/")} target ${target}`);
        }
        // Safety: wire ledger.
        const honestKeys = new Set(honest.map((index) => network.publicKeys[index]));
        result.signaturesSeen = sim.ledger.count;
        const honestConflicts = sim.ledger.conflicts(honestKeys);
        result.honestDoubleSigns = honestConflicts.length;
        if (honestConflicts.length)
            failures.push(`honest double-sign on the wire: ${JSON.stringify(honestConflicts.slice(0, 3))}`);
        result.byzantineDoubleSigns = byzantineCount ? sim.ledger.conflicts(new Set(byzantineIndexes.map((index) => network.publicKeys[index]))).length : 0;
        result.conflictingCertificates = sim.ledger.conflictingCertificates().length;
        if (result.conflictingCertificates)
            failures.push(`conflicting commit certificates: ${JSON.stringify(sim.ledger.conflictingCertificates())}`);
        // Safety: journal audit and "durable before signature".
        result.journalRows = audit.rowsSeen;
        result.journalViolations = [...audit.violations, ...audit.mixedHeights().map((item) => `mixed legacy/v6 rows ${item}`)];
        for (const index of honest) {
            for (const entry of sim.ledger.signedBy(network.publicKeys[index])) {
                for (const value of entry.values) {
                    let ok;
                    if (entry.step === "proposal") {
                        const [blockHash, justify] = value.split("/");
                        ok = audit.has(index, entry.height, entry.round, "proposal", proposalDigest({ chainId: network.chainId, height: entry.height, round: entry.round, blockHash, justifyRound: Number(justify) }));
                    }
                    else {
                        ok = audit.has(index, entry.height, entry.round, entry.step, value);
                    }
                    if (!ok)
                        result.unjournaledSignatures.push(`v${index} ${entry.step} ${entry.height}/${entry.round} ${value.slice(0, 16)}`);
                }
            }
        }
        if (result.journalViolations.length)
            failures.push(`journal: ${result.journalViolations.slice(0, 3).join("; ")}`);
        if (result.unjournaledSignatures.length)
            failures.push(`signature without durable journal row: ${result.unjournaledSignatures.slice(0, 3).join("; ")}`);
        // Safety: finalized chains of honest validators (agreement + prefix consistency).
        const top = Math.max(...honest.map((index) => sim.height(index)));
        const chains = await Promise.all(honest.map(async (index) => ({
            index,
            blocks: await sim.validators[index].service.store.readFinalizedBlocks(firstHeight - 1, top - firstHeight + 2, 64_000_000)
        })));
        for (let height = firstHeight; height <= top; height += 1) {
            const hashes = new Set();
            for (const { blocks } of chains) {
                const block = blocks.find((item) => item.header.height === height);
                if (block)
                    hashes.add(block.hash);
            }
            if (hashes.size > 1)
                result.conflictingFinality += 1;
        }
        if (result.conflictingFinality)
            failures.push(`conflicting finality at ${result.conflictingFinality} height(s)`);
        for (const { index, blocks } of chains) {
            const height = sim.height(index);
            for (let position = 1; position < blocks.length; position += 1) {
                const block = blocks[position];
                const parent = blocks[position - 1];
                if (block.header.height !== parent.header.height + 1 || block.header.previousHash !== parent.hash) {
                    result.prefixViolations.push(`v${index} broken link at ${block.header.height}`);
                }
            }
            if (blocks.at(-1)?.header.height !== height)
                result.prefixViolations.push(`v${index} store tip ${blocks.at(-1)?.header.height} != height ${height}`);
            for (const block of blocks) {
                const v6 = isConsensusV6(sim.validators[index].service.store.chain.protocolVersionAt(block.header.height));
                if (block.header.height >= activationHeight && (!v6 || block.header.version !== 6 || typeof block.commitRound !== "number" || block.roundCertificate.length !== 0)) {
                    result.upgradeViolations.push(`v${index} height ${block.header.height} is not a v6 block`);
                }
                if (block.header.height < activationHeight && (v6 || "commitRound" in block))
                    result.upgradeViolations.push(`v${index} legacy height ${block.header.height} carries v6 finality`);
            }
        }
        for (const [index, heights] of audit.v6Heights) {
            for (const height of heights)
                if (height < activationHeight)
                    result.upgradeViolations.push(`v${index} v2 journal row at legacy height ${height}`);
        }
        for (const [index, heights] of audit.legacyHeights) {
            for (const height of heights)
                if (height >= activationHeight)
                    result.upgradeViolations.push(`v${index} legacy journal row at v6 height ${height}`);
        }
        if (result.prefixViolations.length)
            failures.push(`prefix: ${result.prefixViolations.slice(0, 3).join("; ")}`);
        if (result.upgradeViolations.length)
            failures.push(`protocol boundary: ${result.upgradeViolations.slice(0, 3).join("; ")}`);
        // Supply invariant: total supply = initial - burned transfer fees (fees are burned), never above the initial supply.
        let supplyOk = true;
        let finalized = 0;
        for (const { index, blocks } of chains) {
            const chain = sim.validators[index].service.store.chain;
            const fees = blocks.filter((block) => block.header.height >= firstHeight)
                .flatMap((block) => block.transactions)
                .reduce((sum, tx) => sum + (tx.kind === "transfer" ? tx.feeAtoms : 0), 0);
            finalized = Math.max(finalized, blocks.filter((block) => block.header.height >= firstHeight).flatMap((block) => block.transactions).filter((tx) => tx.kind === "transfer").length);
            const supply = chain.totalSupplyAtoms();
            result.supply.final.push(supply);
            result.supply.burnedFees.push(fees);
            if (supply !== initialSupply - fees || supply > initialSupply)
                supplyOk = false;
        }
        result.supply.ok = supplyOk;
        result.transfersFinalized = finalized;
        if (!supplyOk)
            failures.push(`supply invariant: ${JSON.stringify(result.supply)}`);
        result.crashes = injector.events.map(({ index, step, point, height, detail }) => ({ index, step, point, height, detail }));
        result.restarts = sim.restarts.length;
        Object.assign(result, {
            idleCrashes: counters.idleCrashes, delayed: counters.delayed, duplicated: counters.duplicated, replayed: counters.replayed,
            lateResponses: counters.lateResponses, linkChanges: counters.linkChanges, disconnects: counters.disconnects, lateJoins: counters.lateJoins,
            restartsWhileLocked: counters.restartsWhileLocked, transfersSubmitted: counters.transfersSubmitted
        });
        result.permanentFaulty = [...permanent].sort((a, b) => a - b);
        result.faulty = [
            byzantineIndexes.length ? `byzantine [${byzantineIndexes.join(",")}]` : "",
            permanent.size ? `fail-stopped [${result.permanentFaulty.join(",")}]` : "",
            outage.length ? `outage [${outage.join(",")}]` : "",
            late.size ? `late [${[...late].map(([index, missing]) => `${index}:-${missing}`).join(",")}]` : ""
        ].filter(Boolean).join(" ") || "none";
        result.ok = failures.length === 0;
        if (failures.length)
            result.failure = `${failures.join(" | ")} | errors: ${sim.errors.slice(-5).join(" / ")}`;
        return result;
    }
    finally {
        sim.stopAll();
        await closeValidators([...sim.validators, ...byzantines.map((item) => item.twin)]);
    }
}
/** One-line summary of a run for logs. */
export function summarizeFault(result) {
    return `${result.ok ? "PASS" : "FAIL"} ${result.scenario} n=${result.n} seed=${result.seed} faulty=${result.faulty} ` +
        `heights=${result.heightsFinalized} (pre-GST ${result.heightsBeforeGst}) postGst=${result.postGst.map((item) => `${item.commitRound}/${item.bound}`).join(",")} ` +
        `crashes=${result.crashes.length}+${result.idleCrashes} failStops=${result.failStops.length} restarts=${result.restarts} ` +
        `delayed=${result.delayed} dup=${result.duplicated} replay=${result.replayed} links=${result.linkChanges} disc=${result.disconnects} late=${result.lateJoins} ` +
        `tx=${result.transfersFinalized}/${result.transfersSubmitted} sigs=${result.signaturesSeen} rows=${result.journalRows} ` +
        `dbl=${result.honestDoubleSigns}/${result.byzantineDoubleSigns} cert=${result.conflictingCertificates} fin=${result.conflictingFinality}` +
        (result.failure ? ` ${result.failure}` : "");
}
