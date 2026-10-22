import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SigningJournal } from "../src/storage.js";
function waitForMessage(child, expected) {
    return new Promise((resolve, reject) => {
        const onMessage = (message) => {
            if (!message || typeof message !== "object" || message.type !== expected)
                return;
            cleanup();
            resolve();
        };
        const onExit = (code, signal) => {
            cleanup();
            reject(new Error(`Signing-journal holder exited before ${expected}: code=${code} signal=${signal}`));
        };
        const cleanup = () => {
            child.off("message", onMessage);
            child.off("exit", onExit);
        };
        child.on("message", onMessage);
        child.once("exit", onExit);
    });
}
function sendProbe(child) {
    return new Promise((resolve, reject) => {
        child.send?.("probe", (error) => error ? reject(error) : resolve());
    });
}
test("signing journal hard-crash lease uses deterministic holder liveness", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zyron-signing-crash-ipc-"));
    const holder = join(process.cwd(), "dist", "test", "helpers", "signing-lease-holder.js");
    const child = spawn(process.execPath, [holder, directory], {
        stdio: ["ignore", "ignore", "pipe", "ipc"]
    });
    try {
        await waitForMessage(child, "reserved");
        const holding = waitForMessage(child, "holding");
        await sendProbe(child);
        await holding;
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        let rejectUnexpectedExit;
        const unexpectedExit = new Promise((_resolve, reject) => { rejectUnexpectedExit = reject; });
        const onUnexpectedExit = (code, signal) => {
            rejectUnexpectedExit(new Error(`Signing-journal holder exited during concurrent-open assertion: code=${code} signal=${signal}`));
        };
        child.once("exit", onUnexpectedExit);
        await Promise.race([
            assert.rejects(() => SigningJournal.open(directory), /already has an active validator writer/),
            unexpectedExit
        ]);
        child.off("exit", onUnexpectedExit);
        assert.equal(child.exitCode, null);
        assert.equal(child.signalCode, null);
        const exited = new Promise((resolve) => child.once("exit", () => resolve()));
        assert.equal(child.kill("SIGKILL"), true);
        await exited;
        const recovered = await SigningJournal.open(directory);
        await recovered.reserveAttestation(8, 0, "a".repeat(64));
        await assert.rejects(() => recovered.reserveAttestation(8, 0, "b".repeat(64)), /Conflicting validator action/);
        recovered.close();
    }
    finally {
        if (child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
        await rm(directory, { recursive: true, force: true });
    }
});
