// Open TESTNET consensus relay (docs/CONSENSUS_RELAY.md): lets allowlisted
// external validators take part in v6 consensus with outbound HTTPS only.
// The relay is untrusted transport. It never holds a validator key and never
// creates or changes a vote: it moves the exact request and reply bytes, and
// every vote is verified by the receiving node's own v6 rules.
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { signCanonicalDomain, verifyCanonicalDomain, publicKeyFromPrivate } = await import(join(l1Root, "dist/src/crypto.js"));

export const RELAY_DOMAIN = "zyronchain/open-testnet-relay/v1";
export const RELAY_AUTH_HEADER = "x-zyron-relay-auth";
export const RELAY_CONSENSUS_PATHS = Object.freeze(["/v6/prepare", "/v6/commit", "/v6/timeout", "/v6/block", "/block"]);
export const RELAY_OPS = Object.freeze(["poll", "reply", "forward"]);
export const MAX_RELAY_PEERS = 16;
export const RELAY_CLOCK_SKEW_MS = 60_000;
export const RELAY_SEEN_WINDOW_MS = 2 * RELAY_CLOCK_SKEW_MS + 10_000;
export const RELAY_MAX_SEEN_PER_PEER = 20_000;
export const RELAY_PEER_ONLINE_MS = 10_000;
export const RELAY_REPLY_WAIT_MS = 6_000;
export const RELAY_POLL_WAIT_MS = 7_000;
export const RELAY_MAX_QUEUE = 32;
export const RELAY_MAX_FORWARDS_IN_FLIGHT = 8;
export const RELAY_REQUESTS_PER_MINUTE = 600;
export const RELAY_MAX_AUTH_HEADER_BYTES = 2_048;
// Request bodies the hosted nodes send to an external peer, and that an
// external leader forwards, are v6 requests (at most a block plus a QC).
export const RELAY_MAX_CONSENSUS_REQUEST_BYTES = 2_700_000;
// Replies: a vote (8 KiB), timeout certificates (128 KB) or a block (2.6 MB).
export const RELAY_MAX_REPLY_BYTES = { "/v6/prepare": 8_192, "/v6/commit": 8_192, "/v6/timeout": 128_000, "/v6/block": 2_600_000, "/block": 4_096, "/status": 64_000, "/blocks": 5_400_000 };
// Read paths a hosted node may send to an external peer's mailbox, so that a
// hosted restore that lost recent blocks can sync forward from an external
// validator's durable history (blocks are fully validated by the reader).
export const RELAY_READ_PATHS = Object.freeze(["/status", "/blocks"]);
export const RELAY_MAX_SYNC_BLOCKS = 2;
export const RELAY_MAX_POLL_RESPONSE_BYTES = 4_000_000;
export const RELAY_MAX_BODY_BYTES = 8_000_000;

const ADDRESS = /^ZYN[0-9a-f]{40}$/;
const PUBKEY = /^[0-9a-f]{128}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const SIG = /^[0-9a-f]{128}$/;

export class RelayError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** `ZYRON_RELAY_PEERS=<validatorAddress>=<relayPublicKey>,...` → Map. */
export function parseRelayPeers(value) {
  const peers = new Map();
  if (value === undefined || value.trim() === "") return peers;
  for (const item of value.split(",")) {
    const [address, publicKey, extra] = item.trim().split("=");
    if (extra !== undefined || !ADDRESS.test(address ?? "") || !PUBKEY.test(publicKey ?? "")) throw new Error("ZYRON_RELAY_PEERS: each entry must be <address>=<relay public key>");
    if (peers.has(address)) throw new Error("ZYRON_RELAY_PEERS: duplicate address");
    peers.set(address, publicKey);
  }
  if (peers.size > MAX_RELAY_PEERS) throw new Error(`ZYRON_RELAY_PEERS: at most ${MAX_RELAY_PEERS} peers`);
  return peers;
}

/** Client side: the auth header for one relay request. */
export function createRelayAuthHeader({ chainId, genesisHash, address, seq, issuedAtMs = Date.now(), op, body }, relayPrivateKey) {
  const envelope = { chainId, genesisHash, address, seq, issuedAtMs, op, bodyHash: sha256Hex(body) };
  const signature = signCanonicalDomain(RELAY_DOMAIN, envelope, relayPrivateKey);
  return Buffer.from(JSON.stringify({ envelope, signature })).toString("base64url");
}

export function relayPublicKey(relayPrivateKey) { return publicKeyFromPrivate(relayPrivateKey); }

class Window {
  constructor(limit, windowMs, now) { this.limit = limit; this.windowMs = windowMs; this.now = now; this.start = 0; this.count = 0; }
  take() {
    const t = this.now();
    if (t - this.start >= this.windowMs) { this.start = t; this.count = 0; }
    if (this.count >= this.limit) return false;
    this.count += 1; return true;
  }
}

export class ConsensusRelay {
  /**
   * @param {object} options
   * @param {string} options.chainId
   * @param {string} options.genesisHash
   * @param {Map<string,string>} options.peers validator address → relay public key
   * @param {number} options.hostedCount number of hosted validators
   * @param {(index:number, path:string, body:Buffer) => Promise<{status:number, body:Buffer}>} options.forwardToHosted
   */
  constructor({ chainId, genesisHash, peers, hostedCount, forwardToHosted, isVotingPeer = () => true, now = () => Date.now(), replyWaitMs = RELAY_REPLY_WAIT_MS, pollWaitMs = RELAY_POLL_WAIT_MS }) {
    // Consensus requests reach only peers that are in the active validator
    // set, so allowlisted candidates never take collector slots.
    this.isVotingPeer = isVotingPeer;
    this.chainId = chainId; this.genesisHash = genesisHash; this.hostedCount = hostedCount;
    this.forwardToHosted = forwardToHosted; this.now = now; this.replyWaitMs = replyWaitMs; this.pollWaitMs = pollWaitMs;
    this.peers = new Map();
    for (const [address, publicKey] of peers) {
      this.peers.set(address, { address, publicKey, seen: new Map(), lastPollAt: -Infinity, queue: [], pending: new Map(), waiter: undefined,
        rate: new Window(RELAY_REQUESTS_PER_MINUTE, 60_000, now), forwards: 0 });
    }
  }

  addresses() { return [...this.peers.keys()]; }

  isOnline(address) {
    const peer = this.peers.get(address);
    return Boolean(peer) && (peer.waiter !== undefined || this.now() - peer.lastPollAt <= RELAY_PEER_ONLINE_MS);
  }

  /** Verifies the auth header for `op` over the exact body bytes; returns the peer. */
  authenticate(headerValue, op, body) {
    if (typeof headerValue !== "string" || headerValue.length === 0) throw new RelayError(401, "missing relay authentication");
    if (headerValue.length > RELAY_MAX_AUTH_HEADER_BYTES) throw new RelayError(401, "relay authentication too large");
    let parsed;
    try { parsed = JSON.parse(Buffer.from(headerValue, "base64url").toString("utf8")); } catch { throw new RelayError(401, "malformed relay authentication"); }
    const keys = (value) => value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join(",") : "";
    if (keys(parsed) !== "envelope,signature" || typeof parsed.signature !== "string" || !SIG.test(parsed.signature)) throw new RelayError(401, "malformed relay authentication");
    const e = parsed.envelope;
    if (keys(e) !== "address,bodyHash,chainId,genesisHash,issuedAtMs,op,seq") throw new RelayError(401, "malformed relay envelope");
    if (!Number.isSafeInteger(e.seq) || e.seq < 0 || !Number.isSafeInteger(e.issuedAtMs) || typeof e.address !== "string" || typeof e.bodyHash !== "string" || !HEX64.test(e.bodyHash)) {
      throw new RelayError(401, "malformed relay envelope");
    }
    const peer = this.peers.get(e.address);
    if (!peer) throw new RelayError(401, "unknown relay peer");
    if (e.chainId !== this.chainId || e.genesisHash !== this.genesisHash) throw new RelayError(401, "wrong chain");
    if (e.op !== op) throw new RelayError(401, "wrong relay operation");
    if (!verifyCanonicalDomain(RELAY_DOMAIN, e, parsed.signature, peer.publicKey)) throw new RelayError(401, "bad relay signature");
    const now = this.now();
    if (Math.abs(now - e.issuedAtMs) > RELAY_CLOCK_SKEW_MS) throw new RelayError(401, "stale relay envelope");
    if (sha256Hex(body) !== e.bodyHash) throw new RelayError(401, "relay body hash mismatch");
    for (const [seq, at] of peer.seen) { if (now - at > RELAY_SEEN_WINDOW_MS) peer.seen.delete(seq); else break; }
    if (peer.seen.has(e.seq)) throw new RelayError(401, "replayed relay envelope");
    if (peer.seen.size >= RELAY_MAX_SEEN_PER_PEER) throw new RelayError(429, "relay rate limit exceeded");
    if (!peer.rate.take()) throw new RelayError(429, "relay rate limit exceeded");
    peer.seen.set(e.seq, now);
    return peer;
  }

  /** Public gateway surface: POST /relay/v1/{poll,reply,forward}. */
  async handlePublic(op, headers, body) {
    if (!RELAY_OPS.includes(op)) throw new RelayError(404, "not found");
    if (body.length > RELAY_MAX_BODY_BYTES) throw new RelayError(413, "relay body too large");
    const peer = this.authenticate(headers[RELAY_AUTH_HEADER], op, body);
    let json;
    try { json = JSON.parse(body.toString("utf8")); } catch { throw new RelayError(400, "invalid JSON"); }
    if (!json || typeof json !== "object" || Array.isArray(json)) throw new RelayError(400, "invalid relay body");
    if (op === "poll") return this.poll(peer);
    if (op === "reply") return this.reply(peer, json);
    return this.forward(peer, json);
  }

  async poll(peer) {
    peer.lastPollAt = this.now();
    if (peer.waiter) { peer.waiter.resolve(); peer.waiter = undefined; }
    if (peer.queue.length === 0) {
      await new Promise((done) => {
        const timer = setTimeout(() => { if (peer.waiter?.timer === timer) peer.waiter = undefined; done(); }, this.pollWaitMs);
        peer.waiter = { timer, resolve: () => { clearTimeout(timer); done(); } };
      });
      peer.lastPollAt = this.now();
    }
    const requests = []; let size = 0;
    while (peer.queue.length > 0) {
      const item = peer.queue[0];
      const encoded = item.body.toString("base64");
      if (requests.length > 0 && size + encoded.length > RELAY_MAX_POLL_RESPONSE_BYTES) break;
      peer.queue.shift();
      if (item.expired) continue;
      requests.push({ id: item.id, method: item.method, path: item.path, body: encoded }); size += encoded.length;
    }
    return { status: 200, body: { requests } };
  }

  reply(peer, json) {
    const keys = Object.keys(json).sort().join(",");
    if (keys !== "body,id,status" || typeof json.id !== "string" || !Number.isSafeInteger(json.status) || json.status < 100 || json.status > 599 || typeof json.body !== "string") {
      throw new RelayError(400, "invalid relay reply");
    }
    const entry = peer.pending.get(json.id);
    if (!entry) return { status: 200, body: { accepted: false } };
    const bytes = Buffer.from(json.body, "base64");
    if (bytes.length > RELAY_MAX_REPLY_BYTES[entry.path]) throw new RelayError(413, "relay reply too large");
    peer.pending.delete(json.id);
    entry.resolve({ status: json.status, body: bytes });
    return { status: 200, body: { accepted: true } };
  }

  async forward(peer, json) {
    const keys = Object.keys(json).sort().join(",");
    if (keys !== "body,path,target" || !Number.isSafeInteger(json.target) || json.target < 0 || json.target >= this.hostedCount ||
        !RELAY_CONSENSUS_PATHS.includes(json.path) || typeof json.body !== "string") {
      throw new RelayError(400, "invalid relay forward");
    }
    const bytes = Buffer.from(json.body, "base64");
    if (bytes.length > RELAY_MAX_CONSENSUS_REQUEST_BYTES) throw new RelayError(413, "relay forward too large");
    if (peer.forwards >= RELAY_MAX_FORWARDS_IN_FLIGHT) throw new RelayError(429, "too many relay forwards in flight");
    peer.forwards += 1;
    try {
      const result = await this.forwardToHosted(json.target, json.path, bytes);
      if (result.body.length > RELAY_MAX_REPLY_BYTES[json.path]) throw new RelayError(502, "hosted reply too large");
      return { status: 200, body: { status: result.status, body: result.body.toString("base64") } };
    } finally {
      peer.forwards -= 1;
    }
  }

  /** Loopback mailbox: a hosted node's request for an external peer. */
  async mailbox(address, path, body, method = "POST", query = "") {
    const peer = this.peers.get(address);
    const notFound = { status: 404, body: Buffer.from('{"error":"Not found"}') };
    if (!peer) return notFound;
    let target = path;
    if (method === "GET") {
      if (!RELAY_READ_PATHS.includes(path) || body.length > 0) return notFound;
      if (path === "/blocks") {
        const from = Number.parseInt(new URLSearchParams(query).get("from") ?? "", 10);
        if (!Number.isSafeInteger(from) || from < 1) return { status: 400, body: Buffer.from('{"error":"from must be a positive integer"}') };
        target = `/blocks?from=${from}&limit=${RELAY_MAX_SYNC_BLOCKS}`;
      } else if (query !== "") return notFound;
    } else if (method !== "POST" || !RELAY_CONSENSUS_PATHS.includes(path)) return notFound;
    if (body.length > RELAY_MAX_CONSENSUS_REQUEST_BYTES) return { status: 413, body: Buffer.from('{"error":"too large"}') };
    if (!this.isOnline(address)) return { status: 503, body: Buffer.from('{"error":"relay peer offline"}') };
    if (method === "POST" && !this.isVotingPeer(address)) return { status: 503, body: Buffer.from('{"error":"relay peer is not an active validator"}') };
    const id = randomBytes(16).toString("hex");
    const fireAndForget = path === "/block";
    const item = { id, method, path: target, capPath: path, body, expired: false };
    if (peer.queue.length >= RELAY_MAX_QUEUE) {
      const dropped = peer.queue.shift(); dropped.expired = true;
      peer.pending.get(dropped.id)?.resolve({ status: 503, body: Buffer.from('{"error":"relay queue full"}') }); peer.pending.delete(dropped.id);
    }
    peer.queue.push(item);
    if (peer.waiter) { peer.waiter.resolve(); peer.waiter = undefined; }
    if (fireAndForget) {
      peer.pending.set(id, { path: item.capPath, resolve: () => {} });
      setTimeout(() => peer.pending.delete(id), this.replyWaitMs).unref?.();
      return { status: 202, body: Buffer.from('{"accepted":true}') };
    }
    return new Promise((done) => {
      const timer = setTimeout(() => { item.expired = true; peer.pending.delete(id); done({ status: 504, body: Buffer.from('{"error":"relay peer timeout"}') }); }, this.replyWaitMs);
      peer.pending.set(id, { path: item.capPath, resolve: (result) => { clearTimeout(timer); done(result); } });
    });
  }
}
