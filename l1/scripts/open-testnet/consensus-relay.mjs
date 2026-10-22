// Open TESTNET consensus relay (docs/CONSENSUS_RELAY.md): lets allowlisted
// external validators take part in v6 consensus with outbound HTTPS only.
// The relay is untrusted transport. It never holds a validator key and never
// creates or changes a vote: it moves the exact request and reply bytes, and
// every vote is verified by the receiving node's own v6 rules.
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const { signCanonicalDomain, verifyCanonicalDomain, publicKeyFromPrivate, isValidPublicKey } = await import(join(l1Root, "dist/src/crypto.js"));

export const RELAY_DOMAIN = "zyronchain/open-testnet-relay/v1";
export const RELAY_AUTH_HEADER = "x-zyron-relay-auth";
export const RELAY_CONSENSUS_PATHS = Object.freeze(["/v6/prepare", "/v6/commit", "/v6/timeout", "/v6/block", "/block"]);
export const RELAY_OPS = Object.freeze(["poll", "reply", "forward"]);
export const MAX_RELAY_PEERS = 16;
export const RELAY_CLOCK_SKEW_MS = 60_000;
export const RELAY_SEEN_WINDOW_MS = 2 * RELAY_CLOCK_SKEW_MS + 10_000;
export const RELAY_MAX_SEEN_PER_PEER = 20_000;
// Journal lines beyond the live entries before the replay journal is compacted.
export const RELAY_SEEN_COMPACT_SLACK = 1_000;
export const RELAY_SEEN_FILE_ENV = "ZYRON_RELAY_SEEN_FILE";
export const RELAY_PEER_ONLINE_MS = 10_000;
export const RELAY_REPLY_WAIT_MS = 6_000;
export const RELAY_POLL_WAIT_MS = 7_000;
export const RELAY_MAX_QUEUE = 32;
export const RELAY_MAX_FORWARDS_IN_FLIGHT = 8;
export const RELAY_REQUESTS_PER_MINUTE = 600;
// Forwards into one hosted node from all external peers together stay below
// that node's consensus in-flight limit for its shared loopback identity (4),
// so hosted validators' own traffic always has room.
export const RELAY_MAX_FORWARDS_PER_TARGET = 2;
export const RELAY_MAX_FORWARDS_PER_PEER_TARGET = 1;
// Failed signature checks per client (IP) per minute; above it, the client
// gets 429 before any further signature work. Successful requests are not
// charged here, and forged requests are never charged to the claimed peer.
export const RELAY_MAX_AUTH_FAILURES_PER_MINUTE = 20;
const RELAY_MAX_TRACKED_CLIENTS = 10_000;
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

/** Response headers for relayed consensus/sync replies: node peer clients require the RPC version header. */
export function relayReplyHeaders(length) { return { "content-type": "application/json", "content-length": length, "x-zyron-rpc-version": "1" }; }

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** `ZYRON_RELAY_PEERS=<validatorAddress>=<relayPublicKey>,...` → Map. */
export function parseRelayPeers(value) {
  const peers = new Map();
  if (value === undefined || value.trim() === "") return peers;
  for (const item of value.split(",")) {
    const [address, publicKey, extra] = item.trim().split("=");
    if (extra !== undefined || !ADDRESS.test(address ?? "") || !PUBKEY.test(publicKey ?? "")) throw new Error("ZYRON_RELAY_PEERS: each entry must be <address>=<relay public key>");
    if (!isValidPublicKey(publicKey)) throw new Error(`ZYRON_RELAY_PEERS: relay public key for ${address} is not a valid secp256k1 point`);
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

/** True when `address` is a validator at either of the next two heights of a verified history (`chain.height`, `chain.validatorsAt`). */
export function relayVotingPeer(chain, address) {
  try {
    for (const height of [chain.height + 1, chain.height + 2]) if (chain.validatorsAt(height).some((v) => v.address === address)) return true;
    return false;
  } catch { return false; }
}

// A live owner refreshes its lock at this interval; a lock not refreshed for
// RELAY_LOCK_STALE_MS is stale even if its pid is (re)used by another process.
export const RELAY_LOCK_HEARTBEAT_MS = 5_000;
export const RELAY_LOCK_STALE_MS = 30_000;
// A takeover mutex is held only for a few file operations.
const RELAY_TAKEOVER_STALE_MS = 10_000;

/** Process start time (clock ticks since boot) from /proc, or undefined where unavailable. */
export function processStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19];
  } catch { return undefined; }
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function readLock(path) {
  try {
    const text = readFileSync(path, "utf8");
    const mtimeMs = statSync(path).mtimeMs;
    let owner;
    try { owner = JSON.parse(text); } catch { owner = undefined; }
    return { text, owner, mtimeMs };
  } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/**
 * True while the lock's owner may still be running: its pid is alive, the
 * process start time recorded in the lock still matches that pid (so a reused
 * pid does not count), and the owner has refreshed the lock recently.
 */
function lockLive(lock, staleMs, nowMs = Date.now()) {
  const o = lock.owner;
  // Locks are created whole (exclusive link of a complete file), so one that does not parse is not ours to honour.
  if (!o || typeof o.token !== "string" || !Number.isSafeInteger(o.pid) || o.pid <= 0) return false;
  if (o.pid === process.pid) return heldTokens.has(o.token) && nowMs - lock.mtimeMs <= staleMs;
  if (!processAlive(o.pid)) return false;
  if (o.startTime !== undefined) { const current = processStartTime(o.pid); if (current !== undefined && current !== o.startTime) return false; }
  return nowMs - lock.mtimeMs <= staleMs;
}

const heldTokens = new Set();

function ownerRecord() {
  const token = randomBytes(16).toString("hex");
  return { token, text: JSON.stringify({ pid: process.pid, startTime: processStartTime(process.pid), token }) };
}

/** Atomically creates `path` holding `text` (write a private temp file, then link: fails with EEXIST if `path` exists). */
function createExclusive(path, text) {
  const temp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.new`;
  writeFileSync(temp, text, { flag: "wx", mode: 0o600 });
  try { linkSync(temp, path); return true; } catch (error) { if (error?.code === "EEXIST") return false; throw error; } finally { try { unlinkSync(temp); } catch { /* gone */ } }
}

/**
 * Removes `path` only if it still holds exactly `expectedText`. Callers hold
 * the takeover mutex, so the file cannot be replaced between the comparison
 * and the atomic rename; the renamed file is compared again and put back with
 * an exclusive link if it is not the expected one.
 */
function removeIfUnchanged(path, expectedText) {
  // Compare first, so a file that is not the expected one is never moved (moving it would leave the path briefly empty).
  try { if (readFileSync(path, "utf8") !== expectedText) return false; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  const aside = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.old`;
  try { renameSync(path, aside); } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  if (readFileSync(aside, "utf8") === expectedText) { unlinkSync(aside); return true; }
  try { linkSync(aside, path); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  unlinkSync(aside);
  return false;
}

/**
 * Durable, bounded replay journal: one JSON line `{a,s,t}` per accepted
 * envelope (address, seq, accept time), appended and fsynced before the
 * request is acted on. On open, entries older than the seen window are
 * dropped, each peer keeps at most RELAY_MAX_SEEN_PER_PEER entries, and the
 * file is rewritten atomically (temp file, fsync, rename). It is compacted the
 * same way once it holds RELAY_SEEN_COMPACT_SLACK lines beyond twice the live
 * entries, so its size stays bounded.
 *
 * Single writer: `<file>.lock` holds `{pid, startTime, token}` and is created
 * with an atomic exclusive link. The owner refreshes its mtime every
 * RELAY_LOCK_HEARTBEAT_MS and checks that the token is still its own. A lock
 * is taken over only when its owner is gone (dead pid, a pid reused by another
 * process, or no heartbeat for RELAY_LOCK_STALE_MS), under an exclusive
 * `<file>.lock.takeover` mutex, and only if the lock still holds the exact
 * bytes judged stale. One gateway per journal; gateways on different hosts do
 * not share replay state.
 */
export class RelaySeenStore {
  constructor(path, { now = () => Date.now(), peers, log = (line) => console.error(line), heartbeatMs = RELAY_LOCK_HEARTBEAT_MS, staleMs = RELAY_LOCK_STALE_MS }) {
    this.path = resolve(path); this.now = now; this.peers = peers; this.log = log; this.staleMs = staleMs;
    this.lines = 0; this.fd = undefined; this.failure = undefined; this.lost = false; this.compactRetryAt = 0;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.lockPath = `${this.path}.lock`;
    this.acquireLock();
    try {
      // A journal that did not exist cannot vouch for what an earlier process accepted.
      this.existed = existsSync(this.path);
      this.load(); this.compact();
    } catch (error) { this.close(); throw error; }
    this.heartbeat = setInterval(() => this.beat(), heartbeatMs); this.heartbeat.unref?.();
  }

  acquireLock() {
    const mine = ownerRecord();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (createExclusive(this.lockPath, mine.text)) { this.token = mine.token; this.lockText = mine.text; heldTokens.add(mine.token); return; }
      const lock = readLock(this.lockPath);
      if (!lock) continue;
      if (lockLive(lock, this.staleMs)) throw new Error(`relay replay journal ${this.path} is in use by process ${lock.owner?.pid ?? "unknown"}`);
      this.takeOver(lock.text);
    }
    throw new Error(`relay replay journal ${this.path}: could not take the lock`);
  }

  /** Removes a stale lock, serialized by an exclusive takeover mutex. */
  takeOver(staleText) {
    const mutexPath = `${this.lockPath}.takeover`;
    const mutex = ownerRecord();
    if (!createExclusive(mutexPath, mutex.text)) {
      const held = readLock(mutexPath);
      if (held && !lockLive(held, RELAY_TAKEOVER_STALE_MS)) removeIfUnchanged(mutexPath, held.text);
      return; // someone else is taking over; the caller retries
    }
    heldTokens.add(mutex.token);
    try { removeIfUnchanged(this.lockPath, staleText); } finally { heldTokens.delete(mutex.token); removeIfUnchanged(mutexPath, mutex.text); }
  }

  /** Heartbeat: refresh the lock and confirm it is still ours. */
  beat() {
    if (this.token === undefined) return;
    try {
      if (readFileSync(this.lockPath, "utf8") !== this.lockText) throw new Error("lock was taken by another process");
      const t = new Date(); utimesSync(this.lockPath, t, t);
    } catch (error) {
      this.lost = true;
      this.failure = `relay replay journal ${this.path}: lock lost (${error instanceof Error ? error.message : String(error)}); refusing relay requests`;
      this.log(this.failure);
    }
  }

  load() {
    if (!this.existed) return;
    const now = this.now();
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (line === "") continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; } // a torn final line from a crash
      if (!entry || typeof entry.a !== "string" || !Number.isSafeInteger(entry.s) || !Number.isSafeInteger(entry.t)) continue;
      const peer = this.peers.get(entry.a);
      if (!peer || now - entry.t > RELAY_SEEN_WINDOW_MS) continue;
      peer.seen.delete(entry.s); peer.seen.set(entry.s, entry.t);
    }
    for (const peer of this.peers.values()) {
      const sorted = [...peer.seen].sort((x, y) => x[1] - y[1]).slice(-RELAY_MAX_SEEN_PER_PEER);
      peer.seen = new Map(sorted);
    }
  }

  liveCount() { let n = 0; for (const peer of this.peers.values()) n += peer.seen.size; return n; }

  /** Atomic rewrite. On failure before the rename the old journal and its descriptor stay in use; a failure to reopen afterwards fails closed. */
  compact() {
    const now = this.now();
    const lines = [];
    for (const peer of this.peers.values()) for (const [s, t] of peer.seen) if (now - t <= RELAY_SEEN_WINDOW_MS) lines.push(JSON.stringify({ a: peer.address, s, t }));
    const temp = `${this.path}.${process.pid}.tmp`;
    try {
      const fd = openSync(temp, "w", 0o600);
      try { if (lines.length > 0) writeSync(fd, lines.join("\n") + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      this.renameJournal(temp, this.path);
    } catch (error) { try { unlinkSync(temp); } catch { /* not created */ } throw error; }
    try { const dir = openSync(dirname(this.path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* directory fsync is best effort */ }
    if (this.fd !== undefined) { try { closeSync(this.fd); } catch { /* already closed */ } this.fd = undefined; }
    try { this.fd = this.openAppend(this.path); } catch (error) {
      this.failure = `relay replay journal ${this.path} could not be reopened (${error instanceof Error ? error.message : String(error)}); refusing relay requests`;
      this.log(this.failure);
      throw error;
    }
    this.lines = lines.length;
  }

  renameJournal(from, to) { renameSync(from, to); }
  openAppend(path) { return openSync(path, "a", 0o600); }

  /** Throws when the journal cannot protect against replays (lock lost, journal closed); the relay then refuses requests. */
  assertUsable() {
    if (this.failure !== undefined || this.fd === undefined) throw new RelayError(503, "relay replay journal unavailable");
  }

  /** Durably records an accepted envelope before the relay acts on it. */
  record(address, seq, at) {
    this.assertUsable();
    writeSync(this.fd, JSON.stringify({ a: address, s: seq, t: at }) + "\n");
    fsyncSync(this.fd);
    this.lines += 1;
    if (this.lines > 2 * this.liveCount() + RELAY_SEEN_COMPACT_SLACK && this.now() >= this.compactRetryAt) {
      try { this.compact(); } catch (error) {
        // The entry above is already durable. If the old descriptor is still open the journal keeps working and compaction is retried later.
        this.compactRetryAt = this.now() + 10_000;
        this.log(`relay replay journal ${this.path}: compaction failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }

  close() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = undefined; }
    if (this.fd !== undefined) { try { closeSync(this.fd); } catch { /* already closed */ } this.fd = undefined; }
    if (this.token !== undefined) {
      // Only our own lock is removed: a lock that now holds someone else's token is left alone.
      try { removeIfUnchanged(this.lockPath, this.lockText); } catch { /* best effort */ }
      heldTokens.delete(this.token); this.token = undefined;
    }
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
   * @param {string} [options.seenStorePath] durable replay journal (default: $ZYRON_RELAY_SEEN_FILE). Without one,
   *   envelopes issued before boot + RELAY_CLOCK_SKEW_MS are refused, so nothing a previous process accepted can be replayed.
   */
  constructor({ chainId, genesisHash, peers, hostedCount, forwardToHosted, isVotingPeer = () => true, now = () => Date.now(), replyWaitMs = RELAY_REPLY_WAIT_MS, pollWaitMs = RELAY_POLL_WAIT_MS,
    seenStorePath = process.env[RELAY_SEEN_FILE_ENV] || undefined, log = (line) => console.error(line) }) {
    // Consensus requests reach only peers that are in the active validator
    // set, so allowlisted candidates never take collector slots.
    this.isVotingPeer = isVotingPeer;
    this.authFailures = new Map(); this.signatureChecks = 0; this.targetForwards = new Map();
    this.chainId = chainId; this.genesisHash = genesisHash; this.hostedCount = hostedCount;
    this.forwardToHosted = forwardToHosted; this.now = now; this.replyWaitMs = replyWaitMs; this.pollWaitMs = pollWaitMs;
    this.peers = new Map();
    for (const [address, publicKey] of peers) {
      this.peers.set(address, { address, publicKey, seen: new Map(), lastPollAt: -Infinity, queue: [], pending: new Map(), waiter: undefined,
        rate: new Window(RELAY_REQUESTS_PER_MINUTE, 60_000, now), forwards: 0, targetForwards: new Map() });
    }
    // Replay protection across restarts: a durable seen journal when one is
    // configured; otherwise a boot fence covering everything a previous
    // process could have accepted (issuedAtMs <= its clock + skew).
    this.seenStore = seenStorePath ? new RelaySeenStore(seenStorePath, { now, peers: this.peers, log }) : undefined;
    // A journal created just now (first start, or a fresh disk) knows nothing about earlier processes, so the fence applies too.
    this.bootFenceMs = this.seenStore?.existed ? -Infinity : now() + RELAY_CLOCK_SKEW_MS;
    this.replayProtection = !this.seenStore ? "boot-fence" : this.seenStore.existed ? "journal" : "journal+boot-fence";
    if (this.peers.size > 0) {
      if (!this.seenStore) log(`consensus relay: replay protection = boot fence only (${RELAY_SEEN_FILE_ENV} unset): envelopes issued before ${new Date(this.bootFenceMs).toISOString()} are refused; set ${RELAY_SEEN_FILE_ENV} to a writable path to keep replay state across restarts`);
      else log(`consensus relay: replay protection = journal ${this.seenStore.path}${this.seenStore.existed ? "" : " (new journal: boot fence until " + new Date(this.bootFenceMs).toISOString() + ")"}`);
    }
  }

  /** Releases the replay journal and its lock. */
  close() { this.seenStore?.close(); }

  addresses() { return [...this.peers.keys()]; }

  isOnline(address) {
    const peer = this.peers.get(address);
    return Boolean(peer) && (peer.waiter !== undefined || this.now() - peer.lastPollAt <= RELAY_PEER_ONLINE_MS);
  }

  /** Verifies the auth header for `op` over the exact body bytes; returns the peer. */
  authenticate(headerValue, op, body, clientId = "unknown") {
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
    const failures = this.authFailureWindow(clientId);
    if (failures.count >= RELAY_MAX_AUTH_FAILURES_PER_MINUTE) throw new RelayError(429, "too many relay authentication failures");
    this.signatureChecks += 1;
    if (!verifyCanonicalDomain(RELAY_DOMAIN, e, parsed.signature, peer.publicKey)) { failures.count += 1; throw new RelayError(401, "bad relay signature"); }
    const now = this.now();
    if (Math.abs(now - e.issuedAtMs) > RELAY_CLOCK_SKEW_MS) throw new RelayError(401, "stale relay envelope");
    if (sha256Hex(body) !== e.bodyHash) throw new RelayError(401, "relay body hash mismatch");
    for (const [seq, at] of peer.seen) { if (now - at > RELAY_SEEN_WINDOW_MS) peer.seen.delete(seq); else break; }
    if (peer.seen.has(e.seq)) throw new RelayError(401, "replayed relay envelope");
    this.seenStore?.assertUsable();
    if (e.issuedAtMs < this.bootFenceMs) throw new RelayError(401, "relay envelope predates this relay instance");
    if (peer.seen.size >= RELAY_MAX_SEEN_PER_PEER) throw new RelayError(429, "relay rate limit exceeded");
    if (!peer.rate.take()) throw new RelayError(429, "relay rate limit exceeded");
    this.seenStore?.record(peer.address, e.seq, now);
    peer.seen.set(e.seq, now);
    return peer;
  }

  authFailureWindow(clientId) {
    const now = this.now();
    let entry = this.authFailures.get(clientId);
    if (entry && now - entry.start >= 60_000) { this.authFailures.delete(clientId); entry = undefined; }
    if (!entry) {
      if (this.authFailures.size >= RELAY_MAX_TRACKED_CLIENTS) {
        for (const [key, value] of this.authFailures) if (now - value.start >= 60_000) this.authFailures.delete(key);
        if (this.authFailures.size >= RELAY_MAX_TRACKED_CLIENTS) this.authFailures.delete(this.authFailures.keys().next().value);
      }
      entry = { start: now, count: 0 }; this.authFailures.set(clientId, entry);
    }
    return entry;
  }

  /** Public gateway surface: POST /relay/v1/{poll,reply,forward}. `clientId` is the caller's rate-limit identity (IP). */
  async handlePublic(op, headers, body, clientId = "unknown") {
    if (!RELAY_OPS.includes(op)) throw new RelayError(404, "not found");
    if (body.length > RELAY_MAX_BODY_BYTES) throw new RelayError(413, "relay body too large");
    const peer = this.authenticate(headers[RELAY_AUTH_HEADER], op, body, clientId);
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
    // Only active validators may send consensus traffic to the hosted nodes.
    if (!this.isVotingPeer(peer.address)) throw new RelayError(403, "relay peer is not an active validator");
    if (peer.forwards >= RELAY_MAX_FORWARDS_IN_FLIGHT) throw new RelayError(429, "too many relay forwards in flight");
    const targetTotal = this.targetForwards.get(json.target) ?? 0;
    const peerTarget = peer.targetForwards.get(json.target) ?? 0;
    if (targetTotal >= RELAY_MAX_FORWARDS_PER_TARGET || peerTarget >= RELAY_MAX_FORWARDS_PER_PEER_TARGET) throw new RelayError(429, "too many relay forwards to this target");
    peer.forwards += 1; this.targetForwards.set(json.target, targetTotal + 1); peer.targetForwards.set(json.target, peerTarget + 1);
    try {
      const result = await this.forwardToHosted(json.target, json.path, bytes);
      if (result.body.length > RELAY_MAX_REPLY_BYTES[json.path]) throw new RelayError(502, "hosted reply too large");
      return { status: 200, body: { status: result.status, body: result.body.toString("base64") } };
    } finally {
      peer.forwards -= 1;
      this.targetForwards.set(json.target, (this.targetForwards.get(json.target) ?? 1) - 1);
      peer.targetForwards.set(json.target, (peer.targetForwards.get(json.target) ?? 1) - 1);
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
