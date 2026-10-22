import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { addressFromPublicKey, isValidPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { RPC_API_VERSION } from "../src/node-base.js";
const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const privateKey = "1".padStart(64, "0");
const onCurve = publicKeyFromPrivate(privateKey);
// Flip the lowest bit of y: still 128 lowercase hex characters, but no longer a secp256k1 point.
const offCurve = onCurve.slice(0, -2) + (parseInt(onCurve.slice(-2), 16) ^ 1).toString(16).padStart(2, "0");
async function startMockRpc() {
    const requests = [];
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        requests.push(path);
        let body;
        if (path === "/status")
            body = { chainId: "cli-proposal-key", height: 0 };
        else if (path.startsWith("/nonce/"))
            body = { nonce: 0 };
        else if (path === "/protocol")
            body = { currentVersion: 1, nextVersion: 1 };
        else {
            response.writeHead(404, { "x-zyron-rpc-version": String(RPC_API_VERSION) });
            response.end();
            return;
        }
        response.writeHead(200, { "content-type": "application/json", "x-zyron-rpc-version": String(RPC_API_VERSION) });
        response.end(JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return { server, url: `http://127.0.0.1:${address.port}`, requests };
}
async function runProposal(dir, rpc, validatorKey, out) {
    try {
        const result = await execFileAsync(process.execPath, [
            cli, "validator-proposal",
            "--out", out,
            "--rpc", rpc,
            "--key", join(dir, "key.json"),
            "--activation-height", "200",
            "--validator-public-key", validatorKey
        ], { encoding: "utf8", timeout: 20_000 });
        return { code: 0, stdout: result.stdout, stderr: result.stderr };
    }
    catch (error) {
        const failure = error;
        return { code: failure.code ?? 1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
    }
}
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
test("CLI validator-proposal refuses an off-curve validator key and writes no artifact", async () => {
    assert.equal(offCurve.length, 128);
    assert.equal(isValidPublicKey(offCurve), false);
    const dir = await mkdtemp(join(tmpdir(), "zyron-cli-proposal-key-"));
    const rpc = await startMockRpc();
    try {
        await writeFile(join(dir, "key.json"), JSON.stringify({ privateKey }), { mode: 0o600 });
        const out = join(dir, "proposal.json");
        const result = await runProposal(dir, rpc.url, offCurve, out);
        assert.notEqual(result.code, 0, `off-curve proposal must fail; stdout=${result.stdout} stderr=${result.stderr}`);
        assert.match(result.stderr, /not a valid secp256k1 point/);
        assert.equal(await exists(out), false, "no proposal artifact may be written for an off-curve key");
        assert.deepEqual(rpc.requests, [], "the key must be rejected before any RPC request");
    }
    finally {
        rpc.server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
test("CLI validator-proposal still writes a proposal for a valid validator key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zyron-cli-proposal-key-ok-"));
    const rpc = await startMockRpc();
    try {
        await writeFile(join(dir, "key.json"), JSON.stringify({ privateKey }), { mode: 0o600 });
        const out = join(dir, "proposal.json");
        const result = await runProposal(dir, rpc.url, onCurve, out);
        assert.equal(result.code, 0, `valid proposal must succeed; stderr=${result.stderr}`);
        const proposal = JSON.parse(await readFile(out, "utf8"));
        assert.deepEqual(proposal.validators, [{ address: addressFromPublicKey(onCurve), publicKey: onCurve }]);
    }
    finally {
        rpc.server.close();
        await rm(dir, { recursive: true, force: true });
    }
});
