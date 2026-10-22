// Open TESTNET consensus relay (docs/CONSENSUS_RELAY.md): the relay is
// untrusted transport for allowlisted external validators. Adversarial
// envelopes (forged, unknown, wrong chain, stale, replayed, body-swapped,
// oversized) are rejected; consensus bytes pass through unchanged both ways.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const relayModule: any = await import(join(l1Root, "scripts", "open-testnet", "consensus-relay.mjs"));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clientModule: any = await import(join(l1Root, "scripts", "consensus-relay-client.mjs"));
const { ConsensusRelay, createRelayAuthHeader, parseRelayPeers, RELAY_AUTH_HEADER, RELAY_MAX_BODY_BYTES, RELAY_MAX_CONSENSUS_REQUEST_BYTES } = relayModule;

const CHAIN = "zyron-relay-test-1";
const GENESIS = "ab".repeat(32);
const ADDRESS = `ZYN${"1".repeat(40)}`;
const relayKey = generatePrivateKey();
const peers = new Map([[ADDRESS, publicKeyFromPrivate(relayKey)]]);

function makeRelay(overrides: Record<string, unknown> = {}) {
  const forwarded: Array<{ index: number; path: string; body: Buffer }> = [];
  const relay = new ConsensusRelay({
    chainId: CHAIN, genesisHash: GENESIS, peers, hostedCount: 4, replyWaitMs: 300, pollWaitMs: 200,
    async forwardToHosted(index: number, path: string, body: Buffer) { forwarded.push({ index, path, body }); return { status: 200, body: Buffer.from('{"vote":{"x":1}}') }; },
    ...overrides
  });
  return { relay, forwarded };
}
let seq = 1;
function auth(op: string, body: Buffer, patch: Record<string, unknown> = {}, key = relayKey) {
  return createRelayAuthHeader({ chainId: CHAIN, genesisHash: GENESIS, address: ADDRESS, seq: seq++, op, body, ...patch }, key);
}
async function rejects(promise: Promise<unknown>, status: number, pattern: RegExp) {
  await assert.rejects(promise, (error: { statusCode?: number; message: string }) => { assert.equal(error.statusCode, status); assert.match(error.message, pattern); return true; });
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
  const h = (value: string) => ({ [RELAY_AUTH_HEADER]: value });
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
  const send = (payload: unknown) => { const b = Buffer.from(JSON.stringify(payload)); return relay.handlePublic("forward", { [RELAY_AUTH_HEADER]: auth("forward", b) }, b); };
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

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  return (server.address() as { port: number }).port;
}

test("end to end: hosted→external and external→hosted bytes are relayed unchanged", async () => {
  const hostedSeen: string[] = [];
  const { relay } = makeRelay({
    replyWaitMs: 3_000, pollWaitMs: 500,
    async forwardToHosted(index: number, path: string, body: Buffer) { hostedSeen.push(`${index}${path}${body}`); return { status: 200, body: Buffer.from('{"vote":"hosted-signed"}') }; }
  });
  const gateway = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    try {
      const result = await relay.handlePublic((req.url ?? "").slice("/relay/v1/".length), req.headers, Buffer.concat(chunks));
      res.writeHead(result.status, { "content-type": "application/json" }); res.end(JSON.stringify(result.body));
    } catch (error) { res.writeHead((error as { statusCode?: number }).statusCode ?? 500); res.end(JSON.stringify({ error: (error as Error).message })); }
  });
  const externalNode = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    res.writeHead(200, { "content-type": "application/json" }); res.end(`{"vote":"external-signed","echo":${Buffer.concat(chunks)}}`);
  });
  const gatewayPort = await listen(gateway); const nodePort = await listen(externalNode);
  const client = clientModule.createRelayClient({ gateway: `http://127.0.0.1:${gatewayPort}`, address: ADDRESS, relayKey, chainId: CHAIN, genesisHash: GENESIS, nodeUrl: `http://127.0.0.1:${nodePort}`, log: () => {} });
  const clientPort = await client.start(0);
  try {
    for (let i = 0; i < 50 && !relay.isOnline(ADDRESS); i += 1) await new Promise((d) => setTimeout(d, 50));
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
  } finally {
    await client.stop(); gateway.closeAllConnections(); externalNode.closeAllConnections();
    await new Promise((d) => gateway.close(() => d(undefined))); await new Promise((d) => externalNode.close(() => d(undefined)));
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
  assert.deepEqual(requests.map((r: { method: string; path: string }) => [r.method, r.path]), [["GET", "/blocks?from=5&limit=2"]]);
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
