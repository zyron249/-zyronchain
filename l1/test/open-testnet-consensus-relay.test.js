// Open TESTNET consensus relay (docs/CONSENSUS_RELAY.md): the relay is
// untrusted transport for allowlisted external validators. Adversarial
// envelopes (forged, unknown, wrong chain, stale, replayed, body-swapped,
// oversized) are rejected; consensus bytes pass through unchanged both ways.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const relayModule = await import(join(l1Root, "scripts", "open-testnet", "consensus-relay.mjs"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientModule = await import(join(l1Root, "scripts", "consensus-relay-client.mjs"));
const { ConsensusRelay, createRelayAuthHeader, parseRelayPeers, RELAY_AUTH_HEADER, RELAY_MAX_BODY_BYTES, RELAY_MAX_CONSENSUS_REQUEST_BYTES, RELAY_CLOCK_SKEW_MS, RELAY_SEEN_WINDOW_MS, RELAY_MAX_SEEN_PER_PEER, RELAY_SEEN_COMPACT_SLACK } = relayModule;
const journalRoot = mkdtempSync(join(tmpdir(), "zyron-relay-seen-test-"));
process.on("exit", () => rmSync(journalRoot, { recursive: true, force: true }));
let journalCount = 0;
const freshJournal = () => join(journalRoot, `seen-${journalCount++}.jsonl`);
const CHAIN = "zyron-relay-test-1";
const GENESIS = "ab".repeat(32);
const ADDRESS = `ZYN${"1".repeat(40)}`;
const relayKey = generatePrivateKey();
const peers = new Map([[ADDRESS, publicKeyFromPrivate(relayKey)]]);
function makeRelay(overrides = {}) {
    const forwarded = [];
    const relay = new ConsensusRelay({
        chainId: CHAIN, genesisHash: GENESIS, peers, hostedCount: 4, replyWaitMs: 300, pollWaitMs: 200, seenStorePath: freshJournal(),
        async forwardToHosted(index, path, body) { forwarded.push({ index, path, body }); return { status: 200, body: Buffer.from('{"vote":{"x":1}}') }; },
        ...overrides
    });
    return { relay, forwarded };
}
let seq = 1;
function auth(op, body, patch = {}, key = relayKey) {
    return createRelayAuthHeader({ chainId: CHAIN, genesisHash: GENESIS, address: ADDRESS, seq: seq++, op, body, ...patch }, key);
}
async function rejects(promise, status, pattern) {
    await assert.rejects(promise, (error) => { assert.equal(error.statusCode, status); assert.match(error.message, pattern); return true; });
}
test("relay peers config is strict", () => {
    assert.equal(parseRelayPeers(undefined).size, 0);
    assert.equal(parseRelayPeers(`${ADDRESS}=${publicKeyFromPrivate(relayKey)}`).size, 1);
    assert.throws(() => parseRelayPeers("ZYNxyz=00"), /ZYRON_RELAY_PEERS/);
    // 128 hex characters that are not a secp256k1 point (transcription error) fail at startup.
    assert.throws(() => parseRelayPeers(`${ADDRESS}=${"0".repeat(128)}`), /not a valid secp256k1 point/);
    assert.throws(() => parseRelayPeers(`${ADDRESS}=${publicKeyFromPrivate(relayKey)},${ADDRESS}=${publicKeyFromPrivate(relayKey)}`), /duplicate/);
});
test("adversarial envelopes are rejected before any relay action", async () => {
    const { relay, forwarded } = makeRelay();
    const body = Buffer.from(JSON.stringify({ target: 0, path: "/v6/prepare", body: Buffer.from("{}").toString("base64") }));
    const h = (value) => ({ [RELAY_AUTH_HEADER]: value });
    await rejects(relay.handlePublic("forward", {}, body), 401, /missing/);
    await rejects(relay.handlePublic("forward", h("!!"), body), 401, /malformed/);
    await rejects(relay.handlePublic("forward", h(auth("forward", body, {}, generatePrivateKey())), body), 401, /signature/);
    await rejects(relay.handlePublic("forward", h(auth("forward", body, { address: `ZYN${"2".repeat(40)}` })), body), 401, /unknown/);
    await rejects(relay.handlePublic("forward", h(auth("forward", body, { chainId: "zyron-other-1" })), body), 401, /wrong chain/);
    await rejects(relay.handlePublic("forward", h(auth("forward", body, { genesisHash: "cd".repeat(32) })), body), 401, /wrong chain/);
    await rejects(relay.handlePublic("forward", h(auth("poll", body)), body), 401, /operation/);
    await rejects(relay.handlePublic("forward", h(auth("forward", body, { issuedAtMs: Date.now() - 120_000 })), body), 401, /stale/);
    await rejects(relay.handlePublic("forward", h(auth("forward", body, { issuedAtMs: Date.now() + 120_000 })), body), 401, /stale/);
    await rejects(relay.handlePublic("forward", h(auth("forward", Buffer.from("{}"))), body), 401, /body hash/);
    const once = auth("forward", body);
    await relay.handlePublic("forward", h(once), body);
    await rejects(relay.handlePublic("forward", h(once), body), 401, /replayed/);
    assert.equal(forwarded.length, 1, "only the single valid envelope reached a hosted node");
    await rejects(relay.handlePublic("forward", h("a".repeat(5000)), body), 401, /too large/);
    const huge = Buffer.alloc(RELAY_MAX_BODY_BYTES + 1, 32);
    await rejects(relay.handlePublic("forward", h(auth("forward", huge)), huge), 413, /too large/);
});
test("forward is limited to consensus paths, valid targets and size caps", async () => {
    const { relay, forwarded } = makeRelay();
    const send = (payload) => { const b = Buffer.from(JSON.stringify(payload)); return relay.handlePublic("forward", { [RELAY_AUTH_HEADER]: auth("forward", b) }, b); };
    await rejects(send({ target: 0, path: "/tx", body: "" }), 400, /invalid/);
    await rejects(send({ target: 0, path: "/validator/proposal", body: "" }), 400, /invalid/);
    await rejects(send({ target: 4, path: "/v6/prepare", body: "" }), 400, /invalid/);
    await rejects(send({ target: 0, path: "/v6/prepare", body: "", extra: 1 }), 400, /invalid/);
    await rejects(send({ target: 0, path: "/v6/prepare", body: Buffer.alloc(RELAY_MAX_CONSENSUS_REQUEST_BYTES + 1).toString("base64") }), 413, /too large/);
    const ok = await send({ target: 2, path: "/v6/commit", body: Buffer.from('{"a":1}').toString("base64") });
    assert.equal(ok.body.status, 200);
    assert.equal(Buffer.from(ok.body.body, "base64").toString(), '{"vote":{"x":1}}');
    assert.deepEqual(forwarded.map((f) => [f.index, f.path, f.body.toString()]), [[2, "/v6/commit", '{"a":1}']]);
});
test("mailbox: offline peer answers 503 at once; unknown paths 404; oversized replies refused", async () => {
    const { relay } = makeRelay();
    const started = Date.now();
    assert.equal((await relay.mailbox(ADDRESS, "/v6/prepare", Buffer.from("{}"))).status, 503);
    assert.ok(Date.now() - started < 100, "an absent external peer must not delay the hosted round");
    assert.equal((await relay.mailbox(ADDRESS, "/validator/submit", Buffer.from("{}"))).status, 404);
    assert.equal((await relay.mailbox(`ZYN${"3".repeat(40)}`, "/v6/prepare", Buffer.from("{}"))).status, 404);
    const pollBody = Buffer.from("{}");
    const polled = relay.handlePublic("poll", { [RELAY_AUTH_HEADER]: auth("poll", pollBody) }, pollBody);
    const pending = relay.mailbox(ADDRESS, "/v6/prepare", Buffer.from('{"p":1}'));
    const { body: { requests } } = await polled;
    assert.equal(requests.length, 1);
    const big = Buffer.from(JSON.stringify({ id: requests[0].id, status: 200, body: Buffer.alloc(9_000).toString("base64") }));
    await rejects(relay.handlePublic("reply", { [RELAY_AUTH_HEADER]: auth("reply", big) }, big), 413, /too large/);
    assert.equal((await pending).status, 504, "no valid reply: the hosted caller times out below its 8 s deadline");
});
test("mailbox replies carry the RPC version header the node peer clients require", async () => {
    const { relayReplyHeaders } = relayModule;
    assert.equal(typeof relayReplyHeaders, "function");
    assert.equal(relayReplyHeaders(5)["x-zyron-rpc-version"], "1");
    assert.equal(relayReplyHeaders(5)["content-length"], 5);
    const { readFile } = await import("node:fs/promises");
    const gatewaySource = await readFile(join(l1Root, "scripts", "open-testnet.mjs"), "utf8");
    const mailboxBlock = gatewaySource.slice(gatewaySource.indexOf("mailbox = createServer"), gatewaySource.indexOf("mailbox.listen"));
    assert.ok(mailboxBlock.length > 0);
    assert.doesNotMatch(mailboxBlock, /writeHead\([^)]*\{ "content-type"/, "every mailbox response uses relayReplyHeaders");
});
async function listen(server) {
    await new Promise((done) => server.listen(0, "127.0.0.1", () => done()));
    return server.address().port;
}
test("end to end: hosted→external and external→hosted bytes are relayed unchanged", async () => {
    const hostedSeen = [];
    const { relay } = makeRelay({
        replyWaitMs: 3_000, pollWaitMs: 500,
        async forwardToHosted(index, path, body) { hostedSeen.push(`${index}${path}${body}`); return { status: 200, body: Buffer.from('{"vote":"hosted-signed"}') }; }
    });
    const gateway = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        try {
            const result = await relay.handlePublic((req.url ?? "").slice("/relay/v1/".length), req.headers, Buffer.concat(chunks));
            res.writeHead(result.status, { "content-type": "application/json" });
            res.end(JSON.stringify(result.body));
        }
        catch (error) {
            res.writeHead(error.statusCode ?? 500);
            res.end(JSON.stringify({ error: error.message }));
        }
    });
    const externalNode = createServer(async (req, res) => {
        const chunks = [];
        for await (const c of req)
            chunks.push(c);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(`{"vote":"external-signed","echo":${Buffer.concat(chunks)}}`);
    });
    const gatewayPort = await listen(gateway);
    const nodePort = await listen(externalNode);
    const client = clientModule.createRelayClient({ gateway: `http://127.0.0.1:${gatewayPort}`, address: ADDRESS, relayKey, chainId: CHAIN, genesisHash: GENESIS, nodeUrl: `http://127.0.0.1:${nodePort}`, log: () => { } });
    const clientPort = await client.start(0);
    try {
        for (let i = 0; i < 50 && !relay.isOnline(ADDRESS); i += 1)
            await new Promise((d) => setTimeout(d, 50));
        const inbound = await relay.mailbox(ADDRESS, "/v6/prepare", Buffer.from('{"h":7}'));
        assert.equal(inbound.status, 200);
        assert.equal(inbound.body.toString(), '{"vote":"external-signed","echo":{"h":7}}');
        const outbound = await fetch(`http://127.0.0.1:${clientPort}/h/1/v6/prepare`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"h":8}' });
        assert.equal(outbound.status, 200);
        assert.equal(await outbound.text(), '{"vote":"hosted-signed"}');
        // Node peer clients reject consensus/sync replies without the RPC version header.
        assert.equal(outbound.headers.get("x-zyron-rpc-version"), "1");
        assert.deepEqual(hostedSeen, ['1/v6/prepare{"h":8}']);
        assert.equal((await fetch(`http://127.0.0.1:${clientPort}/h/1/tx`, { method: "POST", body: "{}" })).status, 404);
        assert.equal((await fetch(`http://127.0.0.1:${clientPort}/h/9/v6/prepare`, { method: "POST", body: "{}" })).status, 404);
    }
    finally {
        await client.stop();
        gateway.closeAllConnections();
        externalNode.closeAllConnections();
        await new Promise((d) => gateway.close(() => d(undefined)));
        await new Promise((d) => externalNode.close(() => d(undefined)));
    }
});
test("mailbox: candidates that are not active validators get no consensus requests; reads are capped", async () => {
    let voting = false;
    const { relay } = makeRelay({ isVotingPeer: () => voting, replyWaitMs: 300, pollWaitMs: 300 });
    const pollBody = Buffer.from("{}");
    const poll = () => relay.handlePublic("poll", { [RELAY_AUTH_HEADER]: auth("poll", pollBody) }, pollBody);
    const first = poll();
    const started = Date.now();
    const refused = await relay.mailbox(ADDRESS, "/v6/prepare", Buffer.from("{}"));
    assert.equal(refused.status, 503);
    assert.match(refused.body.toString(), /not an active validator/);
    assert.ok(Date.now() - started < 100, "a non-voting candidate must not hold a collector slot");
    assert.equal((await relay.mailbox(ADDRESS, "/blocks", Buffer.alloc(0), "GET", "from=abc")).status, 400);
    assert.equal((await relay.mailbox(ADDRESS, "/tx", Buffer.alloc(0), "GET", "")).status, 404);
    const read = relay.mailbox(ADDRESS, "/blocks", Buffer.alloc(0), "GET", "from=5&limit=100");
    const { body: { requests } } = await first;
    assert.deepEqual(requests.map((r) => [r.method, r.path]), [["GET", "/blocks?from=5&limit=2"]]);
    const reply = Buffer.from(JSON.stringify({ id: requests[0].id, status: 200, body: Buffer.from('{"blocks":[]}').toString("base64") }));
    await relay.handlePublic("reply", { [RELAY_AUTH_HEADER]: auth("reply", reply) }, reply);
    assert.equal((await read).body.toString(), '{"blocks":[]}');
    voting = true;
    const second = poll();
    const vote = relay.mailbox(ADDRESS, "/v6/prepare", Buffer.from("{}"));
    assert.equal((await second).body.requests.length, 1);
    assert.equal((await vote).status, 504);
});
test("forward: candidates that are not active validators cannot send consensus requests to hosted nodes", async () => {
    let voting = false;
    const { relay, forwarded } = makeRelay({ isVotingPeer: () => voting });
    const body = Buffer.from(JSON.stringify({ target: 0, path: "/v6/prepare", body: Buffer.from("{}").toString("base64") }));
    await rejects(relay.handlePublic("forward", { [RELAY_AUTH_HEADER]: auth("forward", body) }, body), 403, /not an active validator/);
    assert.equal(forwarded.length, 0);
    voting = true;
    const ok = await relay.handlePublic("forward", { [RELAY_AUTH_HEADER]: auth("forward", body) }, body);
    assert.equal(ok.status, 200);
    assert.equal(forwarded.length, 1);
});
test("pre-auth: forged envelopes under a known address are capped per client before signature work", async () => {
    const { relay } = makeRelay();
    const { RELAY_MAX_AUTH_FAILURES_PER_MINUTE } = relayModule;
    assert.ok(Number.isSafeInteger(RELAY_MAX_AUTH_FAILURES_PER_MINUTE) && RELAY_MAX_AUTH_FAILURES_PER_MINUTE > 0);
    const body = Buffer.from("{}");
    const wrongKey = generatePrivateKey();
    for (let i = 0; i < RELAY_MAX_AUTH_FAILURES_PER_MINUTE; i += 1) {
        await rejects(relay.handlePublic("poll", { [RELAY_AUTH_HEADER]: auth("poll", body, {}, wrongKey) }, body, "attacker"), 401, /bad relay signature/);
    }
    const before = relay.signatureChecks;
    await rejects(relay.handlePublic("poll", { [RELAY_AUTH_HEADER]: auth("poll", body, {}, wrongKey) }, body, "attacker"), 429, /authentication failures/);
    assert.equal(relay.signatureChecks, before, "a capped client gets no further signature verification");
    // Forged attempts are not charged to the legitimate peer's quota.
    const ok = relay.handlePublic("poll", { [RELAY_AUTH_HEADER]: auth("poll", body) }, body, "honest");
    assert.equal((await ok).status, 200);
});
test("forward: per hosted target, external traffic stays below the node's shared loopback consensus limit", async () => {
    const { RELAY_MAX_FORWARDS_PER_TARGET, RELAY_MAX_FORWARDS_PER_PEER_TARGET } = relayModule;
    assert.ok(RELAY_MAX_FORWARDS_PER_TARGET < 4, "node consensus inflight per loopback identity is 4");
    const releases = [];
    const second = generatePrivateKey();
    const SECOND = `ZYN${"2".repeat(40)}`;
    const { relay } = makeRelay({
        peers: new Map([[ADDRESS, publicKeyFromPrivate(relayKey)], [SECOND, publicKeyFromPrivate(second)]]),
        async forwardToHosted() { await new Promise((d) => releases.push(d)); return { status: 200, body: Buffer.from("{}") }; }
    });
    const body = (target) => Buffer.from(JSON.stringify({ target, path: "/v6/prepare", body: Buffer.from("{}").toString("base64") }));
    const send = (target, who) => {
        const b = body(target);
        const header = who === "a" ? auth("forward", b) : createRelayAuthHeader({ chainId: CHAIN, genesisHash: GENESIS, address: SECOND, seq: seq++, op: "forward", body: b }, second);
        return relay.handlePublic("forward", { [RELAY_AUTH_HEADER]: header }, b);
    };
    const held = [];
    for (let i = 0; i < RELAY_MAX_FORWARDS_PER_PEER_TARGET; i += 1)
        held.push(send(0, "a"));
    await rejects(send(0, "a"), 429, /target/);
    while (held.length < RELAY_MAX_FORWARDS_PER_TARGET)
        held.push(send(0, "b"));
    await rejects(send(0, "b"), 429, /target/);
    held.push(send(1, "a")); // other targets are independent
    await new Promise((d) => setTimeout(d, 20));
    for (const release of releases)
        release();
    await Promise.all(held);
});
test("voting-peer predicate covers the next two heights of a fresh history", () => {
    const { relayVotingPeer } = relayModule;
    const sets = { 11: ["A"], 12: ["A", ADDRESS] };
    const chain = { height: 10, validatorsAt: (h) => (sets[h] ?? ["A", ADDRESS]).map((address) => ({ address })) };
    assert.equal(relayVotingPeer(chain, ADDRESS), true, "an update activating at the next-but-one height is already reachable");
    assert.equal(relayVotingPeer({ height: 10, validatorsAt: () => [{ address: "A" }] }, ADDRESS), false);
    assert.equal(relayVotingPeer({ height: 10, validatorsAt: () => { throw new Error("x"); } }, ADDRESS), false);
});
test("gateway refreshes the verified validator history from the live chain while the relay is on", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(join(l1Root, "scripts", "open-testnet.mjs"), "utf8");
    assert.match(source, /relayVotingPeer\(snapshotHistory\.chain, address\)/);
    assert.match(source, /setInterval\(\(\) => \{ void refreshHistory\(\)/, "history is extended on a timer, not only by snapshot builds");
});
test("a replayed envelope is rejected after a simulated gateway restart (durable journal)", async () => {
    const path = freshJournal();
    const body = Buffer.from(JSON.stringify({ target: 0, path: "/v6/prepare", body: Buffer.from("{}").toString("base64") }));
    const h = (value) => ({ [RELAY_AUTH_HEADER]: value });
    const first = makeRelay({ seenStorePath: path });
    const once = auth("forward", body);
    await first.relay.handlePublic("forward", h(once), body);
    // A second gateway on the same journal is refused while the first holds it.
    assert.throws(() => makeRelay({ seenStorePath: path }), /in use by process/);
    first.relay.close();
    const second = makeRelay({ seenStorePath: path });
    await rejects(second.relay.handlePublic("forward", h(once), body), 401, /replayed/);
    assert.equal(second.forwarded.length, 0, "the replay never reached a hosted node");
    await second.relay.handlePublic("forward", h(auth("forward", body)), body);
    assert.equal(second.forwarded.length, 1, "fresh envelopes still pass after the restart");
    second.relay.close();
    // A crash leaves a lock from a dead process and possibly a torn final line; both are tolerated.
    writeFileSync(`${path}.lock`, "2147483646");
    writeFileSync(path, readFileSync(path, "utf8") + '{"a":"ZYN', { flag: "w" });
    const third = makeRelay({ seenStorePath: path });
    await rejects(third.relay.handlePublic("forward", h(once), body), 401, /replayed/);
    third.relay.close();
    assert.equal(existsSync(`${path}.lock`), false);
});
test("without a journal, envelopes from before the restart are fenced off", async () => {
    const body = Buffer.from(JSON.stringify({ target: 0, path: "/v6/prepare", body: Buffer.from("{}").toString("base64") }));
    const h = (value) => ({ [RELAY_AUTH_HEADER]: value });
    let clock = 1_000_000_000_000;
    const now = () => clock;
    const first = makeRelay({ seenStorePath: undefined, now });
    // A future-dated envelope (inside the skew) accepted just before the restart.
    clock += RELAY_CLOCK_SKEW_MS + 1;
    const once = auth("forward", body, { issuedAtMs: clock + RELAY_CLOCK_SKEW_MS - 1 });
    await first.relay.handlePublic("forward", h(once), body);
    clock += 1;
    const second = makeRelay({ seenStorePath: undefined, now });
    await rejects(second.relay.handlePublic("forward", h(once), body), 401, /predates this relay instance/);
    assert.equal(second.forwarded.length, 0);
    clock += RELAY_CLOCK_SKEW_MS;
    await second.relay.handlePublic("forward", h(auth("forward", body, { issuedAtMs: clock })), body);
    assert.equal(second.forwarded.length, 1, "envelopes issued after the fence are accepted");
});
test("the replay journal stays bounded by the seen window and the per-peer cap", async () => {
    const path = freshJournal();
    let clock = 2_000_000_000_000;
    const now = () => clock;
    const { relay } = makeRelay({ seenStorePath: path, now });
    const store = relay.seenStore;
    const peer = relay.peers.get(ADDRESS);
    const maxLines = (live) => 2 * live + RELAY_SEEN_COMPACT_SLACK;
    for (let i = 0; i < 3_000; i += 1) {
        clock += 100; // 3,000 accepts over 300 s: older entries leave the window
        relay.authenticate(auth("poll", Buffer.from("{}"), { issuedAtMs: clock }), "poll", Buffer.from("{}"));
        peer.rate.count = 0;
        assert.ok(store.lines <= maxLines(store.liveCount()) + 1);
    }
    assert.ok(peer.seen.size <= Math.ceil(RELAY_SEEN_WINDOW_MS / 100) + 1, `seen ${peer.seen.size}`);
    const lines = readFileSync(path, "utf8").trim().split("\n").length;
    assert.ok(lines <= maxLines(RELAY_SEEN_WINDOW_MS / 100 + 1) + 1, `journal lines ${lines}`);
    relay.close();
    // Reopening prunes to the window and to the per-peer cap and rewrites the file.
    clock += RELAY_SEEN_WINDOW_MS + 1;
    const big = [];
    for (let s = 0; s < RELAY_MAX_SEEN_PER_PEER + 500; s += 1)
        big.push(JSON.stringify({ a: ADDRESS, s: 10_000_000 + s, t: clock }));
    big.push(JSON.stringify({ a: `ZYN${"9".repeat(40)}`, s: 1, t: clock }));
    writeFileSync(path, readFileSync(path, "utf8") + big.join("\n") + "\n");
    const reopened = makeRelay({ seenStorePath: path, now });
    assert.equal(reopened.relay.peers.get(ADDRESS).seen.size, RELAY_MAX_SEEN_PER_PEER);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, RELAY_MAX_SEEN_PER_PEER, "expired, excess and unknown-peer entries are dropped");
    assert.equal(statSync(path).mode & 0o077, 0, "journal is private to the gateway user");
    reopened.relay.close();
});
