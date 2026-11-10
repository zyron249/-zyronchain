// S2-7 merge onto main (S27-R1): #1200's limiter and relay protections still
// apply on the real gateway path after #1205 is merged, and /state/snapshot
// is keeper-only there too (S27-R2).
//
// Runs the real runNetwork gateway (local validators, loopback only). The
// client identity comes from the rightmost X-Forwarded-For entry, which the
// gateway trusts from a loopback peer, so each request can stand for a
// different client. No live endpoints, no real secrets.
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
import { allocateValidatorBasePort } from "./helpers/open-testnet-ports.js";

const l1Root = fileURLToPath(new URL("../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet.mjs")).href);

const READS_PER_MINUTE = 3;
const RELAY_PER_MINUTE = 2;
const MAX_KEYS = 1_000; // the smallest ZYRON_RPC_LIMITER_MAX_KEYS accepts
const ENV = {
  ZYRON_RPC_READS_PER_MINUTE: String(READS_PER_MINUTE),
  ZYRON_RELAY_REQUESTS_PER_MINUTE_PER_IP: String(RELAY_PER_MINUTE),
  ZYRON_RPC_LIMITER_MAX_KEYS: String(MAX_KEYS),
  ZYRON_RELAY_PEERS: `ZYN${"1".repeat(40)}=${publicKeyFromPrivate(generatePrivateKey())}`,
  ZYRON_TRUST_CF_CONNECTING_IP: ""
};

test("S27 gateway: #1200 read/relayIp limits, /48 cap, evict-on-full and /health rateLimiters survive the merge; /state/snapshot is keeper-only", { timeout: 300_000 }, async () => {
  const saved = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, ENV);
  const root = await mkdtemp(join(tmpdir(), "zyron-s27-gw-")); await chmod(root, 0o700);
  const secret = randomBytes(32).toString("base64");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let network: any;
  try {
    await api.initNetwork(join(root, "net"), "zyron-s27-gateway-testnet-1");
    network = await api.runNetwork(join(root, "net"), { gatewayPort: 0, basePort: await allocateValidatorBasePort("s2-7-gateway-limits"), log: false, stateSecret: secret });
    const base = `http://127.0.0.1:${network.port}`;
    const get = async (path: string, client: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}${path}`, { headers: { "x-forwarded-for": client, ...headers } });
      await r.arrayBuffer();
      return r.status;
    };
    const relay = async (client: string) => {
      const r = await fetch(`${base}/relay/v1/forward`, { method: "POST", headers: { "x-forwarded-for": client, "content-type": "application/json" }, body: "{}" });
      await r.arrayBuffer();
      return r.status;
    };
    const health = async () => (await (await fetch(`${base}/health`)).json()).rateLimiters;

    // /health: #1200's rateLimiters fragment, with the S2-7 keeper bucket in place of `snapshot`.
    const initial = await health();
    assert.deepEqual(Object.keys(initial).sort(), ["faucetAddress", "faucetGlobal", "faucetIp", "read", "relayIp", "snapshotKeeper", "write"]);
    for (const name of ["read", "write", "relayIp"]) {
      assert.equal(initial[name].maxKeys, MAX_KEYS, `${name} uses limiterMaxKeys`);
      for (const field of ["size", "deniedFull", "evicted"]) assert.equal(typeof initial[name][field], "number", `${name}.${field}`);
    }
    assert.equal(initial.snapshotKeeper.maxKeys, 1);

    // Per-client read limit (ZYRON_RPC_READS_PER_MINUTE) through the gateway.
    for (let i = 0; i < READS_PER_MINUTE; i += 1) assert.notEqual(await get("/no-such-route", "198.51.100.7"), 429, `read ${i} within the limit`);
    assert.equal(await get("/no-such-route", "198.51.100.7"), 429, "read over the per-client limit");
    assert.notEqual(await get("/no-such-route", "198.51.100.8"), 429, "another client is unaffected");

    // /48 prefix cap (RATE_LIMITER_PREFIX_CAP_DEFAULT = 256) on the read table.
    const cap = api.RATE_LIMITER_PREFIX_CAP_DEFAULT;
    assert.equal(cap, 256);
    const deniedBefore = (await health()).read.deniedFull;
    for (let i = 0; i < cap; i += 1) assert.notEqual(await get("/no-such-route", `2001:db8:48:${i.toString(16)}::1`), 429, `/64 #${i + 1} of one /48`);
    assert.equal(await get("/no-such-route", `2001:db8:48:${cap.toString(16)}::1`), 429, "a 257th live /64 of the same /48 is refused");
    assert.equal((await health()).read.deniedFull, deniedBefore + 1, "the prefix refusal is counted in deniedFull");
    assert.notEqual(await get("/no-such-route", "2001:db8:49::1"), 429, "a /64 in another /48 is admitted");

    // Evict-on-full (PR1200-1): once the read table holds MAX_KEYS live keys a
    // new client is still admitted by evicting the oldest key, never locked out.
    let n = 0;
    while ((await health()).read.size < MAX_KEYS) {
      const batch = MAX_KEYS - (await health()).read.size;
      for (let i = 0; i < batch; i += 1, n += 1) await get("/no-such-route", `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`);
    }
    const full = (await health()).read;
    assert.equal(full.size, MAX_KEYS);
    assert.notEqual(await get("/no-such-route", "203.0.113.200"), 429, "a new client is admitted when the table is full");
    const afterFull = (await health()).read;
    assert.equal(afterFull.size, MAX_KEYS, "the table stays bounded by maxKeys");
    assert.ok(afterFull.evicted > full.evicted, "the oldest key was evicted");

    // relayIp (#1200: limiterMaxKeys + evict-on-full + /48 cap), through POST /relay/v1/*.
    for (let i = 0; i < RELAY_PER_MINUTE; i += 1) assert.notEqual(await relay("198.51.100.9"), 429, `relay ${i} within the limit`);
    assert.equal(await relay("198.51.100.9"), 429, "relay over the per-IP limit");
    for (let i = 0; i < cap; i += 1) assert.notEqual(await relay(`2001:db8:4a:${i.toString(16)}::1`), 429, `relay /64 #${i + 1}`);
    assert.equal(await relay(`2001:db8:4a:${cap.toString(16)}::1`), 429, "relayIp keeps the /48 cap");
    assert.equal((await health()).relayIp.deniedFull, 1);

    // /state/snapshot on the real route: anonymous, empty and wrong bearers get 401.
    assert.equal(await get("/state/snapshot", "198.51.100.20"), 401, "anonymous");
    assert.equal(await get("/state/snapshot", "198.51.100.21", { authorization: "" }), 401, "empty Authorization");
    assert.equal(await get("/state/snapshot", "198.51.100.22", { authorization: `Bearer ${secret}` }), 401, "raw state secret");
    assert.equal((await health()).snapshotKeeper.size, 0, "rejected requests touch no snapshot bucket");

    // Security 1205-r2 LOW: the 401 comes before the shared per-IP read limiter.
    // One IP sends 300 unauthenticated requests in one window (100x its read
    // limit here, and more than the 240/min default): every one is 401, none
    // spends a read slot, and a normal GET from that IP is still served.
    const sprayer = "198.51.100.30";
    const readSizeBefore = (await health()).read.size;
    const spray: number[] = [];
    for (let i = 0; i < 300; i += 1) spray.push(await get("/state/snapshot", sprayer, i % 3 === 0 ? {} : i % 3 === 1 ? { authorization: "" } : { authorization: "Bearer not-the-keeper-token" }));
    assert.deepEqual([...new Set(spray)], [401], `every unauthenticated request is 401 (never 429); got ${[...new Set(spray)].join(",")}`);
    assert.equal((await health()).read.size, readSizeBefore, "no read-table key was created for the sprayer");
    for (let i = 0; i < READS_PER_MINUTE; i += 1) assert.notEqual(await get("/no-such-route", sprayer), 429, `normal GET ${i} from the sprayer is served`);
    assert.equal(await get("/no-such-route", sprayer), 429, "the sprayer still has its own full read quota, and no more");
    const keeper = await get("/state/snapshot", "198.51.100.23", { authorization: `Bearer ${api.deriveSnapshotKeeperBearer(secret)}` });
    assert.ok(keeper === 200 || keeper === 503, `the derived keeper bearer is accepted (200, or 503 before the first build); got ${keeper}`);
  } finally {
    await network?.shutdown();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(root, { recursive: true, force: true });
  }
});
