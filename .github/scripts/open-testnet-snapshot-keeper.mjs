#!/usr/bin/env node
// Open TESTNET snapshot keeper (tokens have no value) for scheduled GitHub Actions.
//
// The hosted open testnet runs on a free web service without a persistent disk.
// Its gateway serves GET /state/snapshot: a bundle that is already sealed
// (AES-256-GCM) by the gateway with a key that exists only on the host. This
// keeper never sees or needs that key. It only:
//   1. polls GET /health so the free instance does not idle out, and
//   2. downloads the sealed snapshot and publishes it as the `state.enc` asset
//      (plus the per-genesis copy `state-<genesis12>.enc`) of the
//      `open-testnet-state` release, which the host restores from on a cold start.
//
// Safety rules (see docs/OPEN_TESTNET.md, "Snapshot keepers"):
//   - a snapshot whose genesis hash is not EXPECTED_GENESIS is never published;
//   - the published height never goes backwards: the keeper labels each asset it
//     publishes with its height and genesis and only replaces it with a higher
//     height. An unlabeled asset (published by the legacy shell keeper, which
//     does not label) is replaced only by a snapshot whose download started more
//     than UNLABELED_MARGIN_MS after that asset was updated; every later snapshot
//     of the same chain is at least as high (the gateway caches a snapshot for at
//     most 60 s), and a restart resumes from the published asset;
//   - the asset is never deleted before its replacement exists: the new file is
//     uploaded under a temporary name, the old asset is deleted and the new one
//     renamed in place, so `state.enc` is missing only between two API calls;
//   - only temporary assets this keeper names are cleaned up.
// The only credential is the workflow GITHUB_TOKEN (contents: write, for the
// release assets).
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appendFile } from "node:fs/promises";

export const SNAPSHOT_HEADER = "ZYRON-OPEN-TESTNET-STATE-V1\n";
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const UNLABELED_MARGIN_MS = 120_000;
export const TEMP_ASSET_PATTERN = /^state-next-(\d{13})-[0-9a-f]{8}\.enc$/;
export const TEMP_ASSET_MAX_AGE_MS = 30 * 60_000;
const LABEL_PATTERN = /^state snapshot height=([1-9][0-9]{0,15}) genesis=([0-9a-f]{64})$/;
const GENESIS_PATTERN = /^[0-9a-f]{64}$/;

export function formatLabel(height, genesis) {
  return `state snapshot height=${height} genesis=${genesis}`;
}

export function parseLabel(label) {
  const match = LABEL_PATTERN.exec(typeof label === "string" ? label : "");
  if (!match) return null;
  const height = Number(match[1]);
  return Number.isSafeInteger(height) ? { height, genesis: match[2] } : null;
}

export function perGenesisName(genesis) {
  return `state-${genesis.slice(0, 12)}.enc`;
}

export function tempAssetName(nowMs, random = randomBytes(4).toString("hex")) {
  return `state-next-${String(nowMs).padStart(13, "0")}-${random}.enc`;
}

// Checks a downloaded snapshot without decrypting it. Returns { height, genesis }.
export function validateSnapshot({ status, headers, bytes }, expectedGenesis) {
  if (status !== 200) throw new Error(`snapshot request returned HTTP ${status}`);
  const heightText = headers.get("x-zyron-snapshot-height") ?? "";
  const genesis = (headers.get("x-zyron-genesis-hash") ?? "").trim();
  if (!/^[1-9][0-9]{0,15}$/.test(heightText.trim())) throw new Error(`snapshot height header is not a positive integer: ${JSON.stringify(heightText)}`);
  const height = Number(heightText.trim());
  if (!Number.isSafeInteger(height)) throw new Error("snapshot height is out of range");
  if (!GENESIS_PATTERN.test(genesis)) throw new Error("snapshot genesis header is not a 64-hex hash");
  if (genesis !== expectedGenesis) throw new GenesisMismatchError(genesis, expectedGenesis);
  const declared = headers.get("content-length");
  if (declared !== null && Number(declared) !== bytes.length) throw new Error(`snapshot is truncated (${bytes.length} of ${declared} bytes)`);
  if (bytes.length <= SNAPSHOT_HEADER.length + 28 || bytes.length > MAX_SNAPSHOT_BYTES) throw new Error(`snapshot size ${bytes.length} is out of range`);
  if (!bytes.subarray(0, SNAPSHOT_HEADER.length).equals(Buffer.from(SNAPSHOT_HEADER))) throw new Error("not an open-testnet sealed state snapshot");
  return { height, genesis };
}

export class GenesisMismatchError extends Error {
  constructor(actual, expected) {
    super(`snapshot genesis ${actual.slice(0, 12)}… is not the expected genesis ${expected.slice(0, 12)}…; refusing to publish`);
    this.name = "GenesisMismatchError";
  }
}

// Decides whether `snapshot` may replace the currently published `asset` (or null).
export function decideReplace({ snapshot, asset, expectedGenesis, requestStartedMs }) {
  if (snapshot.genesis !== expectedGenesis) return { publish: false, reason: "genesis-mismatch" };
  if (!asset) return { publish: true, reason: "no asset published yet" };
  const label = parseLabel(asset.label);
  if (label) {
    if (label.genesis !== expectedGenesis) return { publish: false, reason: `published asset is labeled for genesis ${label.genesis.slice(0, 12)}…` };
    if (snapshot.height > label.height) return { publish: true, reason: `height ${label.height} -> ${snapshot.height}` };
    return { publish: false, reason: `not newer (published height ${label.height}, snapshot ${snapshot.height})` };
  }
  const updatedMs = Date.parse(asset.updated_at ?? "");
  if (!Number.isFinite(updatedMs)) return { publish: false, reason: "published asset has no usable updated_at" };
  if (requestStartedMs > updatedMs + UNLABELED_MARGIN_MS) return { publish: true, reason: `unlabeled asset from ${asset.updated_at}, snapshot requested later` };
  return { publish: false, reason: `unlabeled asset updated ${asset.updated_at} by another keeper moments ago` };
}

export function createGitHub({ fetchImpl, token, repo, apiBase = "https://api.github.com", uploadBase = "https://uploads.github.com" }) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`invalid repository ${repo}`);
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "zyron-open-testnet-snapshot-keeper" };
  async function call(method, url, { body, contentType, okStatuses = [200] } = {}) {
    const response = await fetchImpl(url, { method, headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) }, body, signal: AbortSignal.timeout(120_000) });
    const text = await response.text();
    if (!okStatuses.includes(response.status)) {
      const error = new Error(`${method} ${url.replace(/\?.*$/, "")} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }
  return {
    async release(tag) {
      const release = await call("GET", `${apiBase}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
      const assets = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await call("GET", `${apiBase}/repos/${repo}/releases/${release.id}/assets?per_page=100&page=${page}`);
        assets.push(...batch);
        if (batch.length < 100) break;
      }
      return { id: release.id, assets };
    },
    upload(releaseId, name, label, bytes) {
      const query = new URLSearchParams({ name, label });
      return call("POST", `${uploadBase}/repos/${repo}/releases/${releaseId}/assets?${query}`, { body: bytes, contentType: "application/octet-stream", okStatuses: [201] });
    },
    async remove(assetId) {
      try { await call("DELETE", `${apiBase}/repos/${repo}/releases/assets/${assetId}`, { okStatuses: [204] }); return true; }
      catch (error) { if (error.status === 404) return false; throw error; }
    },
    rename(assetId, name, label) {
      return call("PATCH", `${apiBase}/repos/${repo}/releases/assets/${assetId}`, { body: JSON.stringify({ name, label }), contentType: "application/json" });
    }
  };
}

// Publishes one snapshot as asset `name` if it is newer. Returns "published" or a skip reason.
export async function publishAsset({ github, tag, name, bytes, snapshot, expectedGenesis, requestStartedMs, now, log }) {
  let release = await github.release(tag);
  let current = release.assets.find((asset) => asset.name === name) ?? null;
  const first = decideReplace({ snapshot, asset: current, expectedGenesis, requestStartedMs });
  if (!first.publish) return { published: false, reason: first.reason };
  const label = formatLabel(snapshot.height, snapshot.genesis);
  const temp = await github.upload(release.id, tempAssetName(now()), label, bytes);
  try {
    // Re-check right before the swap: another keeper may have published meanwhile.
    release = await github.release(tag);
    const latest = release.assets.find((asset) => asset.name === name) ?? null;
    if ((latest?.id ?? null) !== (current?.id ?? null)) {
      const again = decideReplace({ snapshot, asset: latest, expectedGenesis, requestStartedMs });
      if (!again.publish) { await github.remove(temp.id); return { published: false, reason: `another keeper published first: ${again.reason}` }; }
      current = latest;
    }
    if (current) await github.remove(current.id);
    try {
      await github.rename(temp.id, name, label);
    } catch (error) {
      // Lost a race with another keeper's upload of the same name: theirs stays.
      if (error.status === 422) { await github.remove(temp.id); return { published: false, reason: "another keeper published the same name concurrently" }; }
      throw error;
    }
    log(`published ${name} height ${snapshot.height} genesis ${snapshot.genesis.slice(0, 12)} (${first.reason})`);
    return { published: true, reason: first.reason };
  } catch (error) {
    await github.remove(temp.id).catch(() => {});
    throw error;
  }
}

export async function cleanupTempAssets({ github, tag, now, log }) {
  const release = await github.release(tag);
  for (const asset of release.assets) {
    const match = TEMP_ASSET_PATTERN.exec(asset.name);
    if (match && now() - Number(match[1]) > TEMP_ASSET_MAX_AGE_MS) {
      await github.remove(asset.id);
      log(`removed stale temporary asset ${asset.name}`);
    }
  }
}

export async function fetchSnapshot({ fetchImpl, gateway, expectedGenesis, now }) {
  const requestStartedMs = now();
  const response = await fetchImpl(`${gateway}/state/snapshot`, { signal: AbortSignal.timeout(300_000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  const snapshot = validateSnapshot({ status: response.status, headers: response.headers, bytes }, expectedGenesis);
  return { snapshot, bytes, requestStartedMs };
}

// One keeper cycle: download, check, publish state.enc then the per-genesis copy.
export async function publishCycle({ fetchImpl, github, gateway, tag, expectedGenesis, now, log }) {
  const { snapshot, bytes, requestStartedMs } = await fetchSnapshot({ fetchImpl, gateway, expectedGenesis, now });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const main = await publishAsset({ github, tag, name: "state.enc", bytes, snapshot, expectedGenesis, requestStartedMs, now, log });
  const copy = await publishAsset({ github, tag, name: perGenesisName(snapshot.genesis), bytes, snapshot, expectedGenesis, requestStartedMs, now, log });
  if (!main.published) log(`state.enc not replaced: ${main.reason}`);
  if (!copy.published) log(`${perGenesisName(snapshot.genesis)} not replaced: ${copy.reason}`);
  return { height: snapshot.height, genesis: snapshot.genesis, sha256, size: bytes.length, published: main.published, copyPublished: copy.published, reason: main.reason };
}

export async function keepAlive({ fetchImpl, gateway }) {
  try {
    const response = await fetchImpl(`${gateway}/health`, { signal: AbortSignal.timeout(90_000) });
    const text = await response.text();
    let body = {};
    try { body = JSON.parse(text); } catch {}
    return { status: response.status, phase: body.status ?? body.phase ?? "?", height: body.maxHeight ?? null };
  } catch (error) {
    return { status: 0, phase: error instanceof Error ? error.message : String(error), height: null };
  }
}

export async function runKeeper(options) {
  const { fetchImpl, github, gateway, tag, expectedGenesis, runMs, publishIntervalMs, keepAliveIntervalMs, now, sleep, log, warn } = options;
  const stats = { cycles: 0, published: 0, notNewer: 0, failures: 0, genesisMismatches: 0, lastPublishedHeight: null, lastHeight: null };
  const deadline = now() + runMs;
  let nextPublish = now();
  let nextKeepAlive = now();
  try { await cleanupTempAssets({ github, tag, now, log }); } catch (error) { warn(`temporary asset cleanup failed: ${error.message}`); }
  while (now() < deadline) {
    if (now() >= nextKeepAlive) {
      const health = await keepAlive({ fetchImpl, gateway });
      log(`health HTTP ${health.status} ${health.phase}${health.height === null ? "" : ` height ${health.height}`}`);
      nextKeepAlive = now() + keepAliveIntervalMs;
    }
    if (now() >= nextPublish) {
      stats.cycles += 1;
      try {
        const result = await publishCycle({ fetchImpl, github, gateway, tag, expectedGenesis, now, log });
        stats.lastHeight = result.height;
        if (result.published) { stats.published += 1; stats.lastPublishedHeight = result.height; log(`snapshot sha256 ${result.sha256} size ${result.size}`); }
        else stats.notNewer += 1;
      } catch (error) {
        if (error instanceof GenesisMismatchError) { stats.genesisMismatches += 1; warn(error.message); }
        else { stats.failures += 1; warn(`cycle failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      nextPublish = now() + publishIntervalMs;
      nextKeepAlive = Math.min(nextKeepAlive, now() + keepAliveIntervalMs);
    }
    const wait = Math.min(nextPublish, nextKeepAlive, deadline) - now();
    if (wait > 0) await sleep(wait);
  }
  return stats;
}

// Exit status: fail on any genesis mismatch, or when the whole run published
// nothing and never saw an up-to-date published asset (gateway or upload broken).
export function exitCodeFor(stats) {
  if (stats.genesisMismatches > 0) return 1;
  if (stats.published === 0 && stats.notNewer === 0) return 1;
  return 0;
}

function envNumber(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number from ${min} to ${max}`);
  return value;
}

async function main() {
  const env = process.env;
  const expectedGenesis = env.EXPECTED_GENESIS ?? "";
  if (!GENESIS_PATTERN.test(expectedGenesis)) throw new Error("EXPECTED_GENESIS must be the full 64-hex genesis hash");
  const gateway = (env.GATEWAY ?? "https://zyron-open-testnet.onrender.com").replace(/\/+$/, "");
  if (!/^https:\/\//.test(gateway)) throw new Error("GATEWAY must be an https URL");
  const tag = env.TAG ?? "open-testnet-state";
  const runMinutes = envNumber(env, "RUN_MINUTES", 340, 1, 340);
  const github = createGitHub({ fetchImpl: fetch, token: env.GITHUB_TOKEN, repo: env.REPO ?? env.GITHUB_REPOSITORY ?? "" });
  const stamp = () => new Date().toISOString();
  const stats = await runKeeper({
    fetchImpl: fetch, github, gateway, tag, expectedGenesis,
    runMs: runMinutes * 60_000,
    publishIntervalMs: envNumber(env, "PUBLISH_INTERVAL_SECONDS", 600, 60, 3600) * 1000,
    keepAliveIntervalMs: envNumber(env, "KEEPALIVE_INTERVAL_SECONDS", 300, 30, 840) * 1000,
    now: Date.now, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log: (line) => console.log(`${stamp()} ${line}`),
    warn: (line) => console.log(`::warning::${stamp()} ${line}`)
  });
  console.log(`${stamp()} done ${JSON.stringify(stats)}`);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `### Open testnet snapshot keeper\n\n| cycles | published | not newer | failures | genesis mismatches | last published height | last seen height |\n|---|---|---|---|---|---|---|\n| ${stats.cycles} | ${stats.published} | ${stats.notNewer} | ${stats.failures} | ${stats.genesisMismatches} | ${stats.lastPublishedHeight ?? "-"} | ${stats.lastHeight ?? "-"} |\n`);
  }
  process.exitCode = exitCodeFor(stats);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(`::error::${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
