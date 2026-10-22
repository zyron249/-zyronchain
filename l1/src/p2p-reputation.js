import { randomBytes } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { peerIdFromString } from "@libp2p/peer-id";
import { readBoundedUtf8File } from "./bounded-file.js";
import { canonicalJson } from "./codec.js";
import { assertBoundedNativeReputationJsonStructure } from "./p2p-reputation-json-complexity.js";
const VERSION = 1;
const MAX_ENTRIES = 256;
const MAX_FAILURES = 32;
const BASE_TRANSIENT_BACKOFF_MS = 30_000;
const MAX_TRANSIENT_BACKOFF_MS = 30 * 60_000;
const PROTOCOL_BAN_MS = 30 * 60_000;
export const MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES = 2 * 1024 * 1024;
export class NativePeerReputationStore {
    path;
    entries = new Map();
    mutationTail = Promise.resolve();
    constructor(path) {
        this.path = path;
    }
    static async open(dataDir) {
        await mkdir(dataDir, { recursive: true, mode: 0o700 });
        const store = new NativePeerReputationStore(join(dataDir, "native-peer-reputation.json"));
        try {
            const text = await readBoundedUtf8File(store.path, MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES, "Native peer reputation snapshot");
            assertBoundedNativeReputationJsonStructure(text);
            const snapshot = validateSnapshot(JSON.parse(text));
            for (const entry of snapshot.peers)
                store.entries.set(entry.peerId, entry);
        }
        catch (error) {
            if (!isMissingFile(error))
                throw new Error("Corrupt native peer reputation store", { cause: error });
        }
        return store;
    }
    isAvailable(peerId, nowMs = Date.now()) {
        validatePeerId(peerId);
        assertTimestamp(nowMs);
        const tracked = this.entries.get(peerId);
        if (tracked)
            return tracked.backoffUntilMs <= nowMs;
        return this.entries.size < MAX_ENTRIES;
    }
    failureCount(peerId) {
        validatePeerId(peerId);
        return this.entries.get(peerId)?.consecutiveFailures ?? 0;
    }
    async recordFailure(peerId, kind, nowMs = Date.now()) {
        validatePeerId(peerId);
        assertTimestamp(nowMs);
        if (kind !== "transient" && kind !== "protocol")
            throw new Error("Invalid native peer failure kind");
        return this.exclusive(async () => {
            const previous = this.entries.get(peerId);
            const consecutiveFailures = Math.min(MAX_FAILURES, (previous?.consecutiveFailures ?? 0) + 1);
            const penalty = kind === "protocol"
                ? PROTOCOL_BAN_MS
                : Math.min(MAX_TRANSIENT_BACKOFF_MS, BASE_TRANSIENT_BACKOFF_MS * (2 ** Math.min(20, consecutiveFailures - 1)));
            if (!previous && !this.hasCapacity())
                return penalty;
            this.entries.set(peerId, {
                peerId,
                consecutiveFailures,
                backoffUntilMs: nowMs + penalty,
                lastFailureMs: nowMs,
                lastSuccessMs: previous?.lastSuccessMs ?? 0,
                lastFailureKind: kind
            });
            await this.persist();
            return penalty;
        });
    }
    async recordSuccess(peerId, nowMs = Date.now()) {
        validatePeerId(peerId);
        assertTimestamp(nowMs);
        await this.exclusive(async () => {
            const previous = this.entries.get(peerId);
            if (!previous && !this.hasCapacity())
                return;
            this.entries.set(peerId, {
                peerId,
                consecutiveFailures: 0,
                backoffUntilMs: 0,
                lastFailureMs: previous?.lastFailureMs ?? 0,
                lastSuccessMs: nowMs,
                lastFailureKind: "none"
            });
            await this.persist();
        });
    }
    async exclusive(operation) {
        const previous = this.mutationTail;
        let release;
        this.mutationTail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            return await operation();
        }
        finally {
            release();
        }
    }
    hasCapacity() {
        return this.entries.size < MAX_ENTRIES;
    }
    async persist() {
        const snapshot = { version: 1, peers: [...this.entries.values()].sort((a, b) => a.peerId.localeCompare(b.peerId)) };
        const serialized = `${canonicalJson(snapshot)}\n`;
        if (Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_REPUTATION_SNAPSHOT_BYTES) {
            throw new Error("Native peer reputation snapshot exceeds persistence byte limit");
        }
        const temporary = `${this.path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
        let renamed = false;
        try {
            const handle = await open(temporary, "wx", 0o600);
            try {
                await handle.writeFile(serialized, "utf8");
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            await rename(temporary, this.path);
            renamed = true;
            if (nativePeerReputationDirectorySyncSupported()) {
                const directory = await open(dirname(this.path), "r");
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
            }
        }
        finally {
            if (!renamed)
                await rm(temporary, { force: true });
        }
    }
}
export function nativePeerReputationDirectorySyncSupported(platform = process.platform) {
    return platform !== "win32";
}
export function classifyNativePeerFailure(error) {
    const message = error instanceof Error ? `${error.name} ${error.message}` : "";
    return /timeout|abort|ECONN|connect|dial|stream|reset|closed/i.test(message) ? "transient" : "protocol";
}
function validateSnapshot(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid native reputation snapshot");
    const record = value;
    if (Object.keys(record).sort().join(",") !== "peers,version" || record.version !== VERSION || !Array.isArray(record.peers) || record.peers.length > MAX_ENTRIES) {
        throw new Error("Invalid native reputation snapshot");
    }
    const seen = new Set();
    const peers = record.peers.map((candidate) => {
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
            throw new Error("Invalid native reputation entry");
        const entry = candidate;
        const keys = "backoffUntilMs,consecutiveFailures,lastFailureKind,lastFailureMs,lastSuccessMs,peerId";
        if (Object.keys(entry).sort().join(",") !== keys || typeof entry.peerId !== "string")
            throw new Error("Invalid native reputation entry");
        validatePeerId(entry.peerId);
        if (seen.has(entry.peerId))
            throw new Error("Duplicate native reputation peer");
        seen.add(entry.peerId);
        for (const key of ["consecutiveFailures", "backoffUntilMs", "lastFailureMs", "lastSuccessMs"]) {
            if (!Number.isSafeInteger(entry[key]) || Number(entry[key]) < 0)
                throw new Error("Invalid native reputation counter");
        }
        if (Number(entry.consecutiveFailures) > MAX_FAILURES || !["none", "transient", "protocol"].includes(String(entry.lastFailureKind))) {
            throw new Error("Invalid native reputation state");
        }
        return entry;
    });
    return { version: 1, peers };
}
function validatePeerId(value) {
    if (value.length < 1 || value.length > 256)
        throw new Error("Invalid native reputation PeerId");
    try {
        peerIdFromString(value);
    }
    catch {
        throw new Error("Invalid native reputation PeerId");
    }
}
function assertTimestamp(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("Invalid native reputation timestamp");
}
function isMissingFile(error) {
    return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
