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
//   - the published asset is never deleted before its replacement is in place:
//     the new file is uploaded as next-<ms>-<hex>.<name>, the current asset is
//     renamed aside to prev-<ms>-<hex>.<name> and the new file is renamed to
//     <name>. The moved-aside copy stays as a backup. If the final rename fails
//     the old asset is renamed back; if that fails too, both copies are kept and
//     the next cycle renames the best one back into place, so `state.enc` is
//     only missing between two API calls and never lost. No swap starts after
//     the run deadline, so a started swap ends before the job timeout;
//   - only this keeper's own next-/prev- copies are ever cleaned up, only when
//     the name they belong to exists (rechecked right before deleting), and the
//     best copy of each name is always kept.
// The only credential is the workflow GITHUB_TOKEN (contents: write, for the
// release assets).
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { appendFile } from "node:fs/promises";

export const SNAPSHOT_HEADER = "ZYRON-OPEN-TESTNET-STATE-V1\n";
export const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;
export const UNLABELED_MARGIN_MS = 120_000;
export const KEEPER_ASSET_PATTERN = /^(next|prev)-(\d{13})-[0-9a-f]{8}\.(state(?:-[0-9a-f]{12})?\.enc)$/;
export const KEEPER_ASSET_MAX_AGE_MS = 30 * 60_000;
// Per-request timeout for GitHub metadata calls (listing, rename, delete). It
// bounds the time a swap can take once started; see publishAsset's swapBy.
export const GITHUB_CALL_TIMEOUT_MS = 60_000;
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

// Names of this keeper's own copies: next-<ms>-<hex>.<final name> (an upload
// before its swap) and prev-<ms>-<hex>.<final name> (the replaced asset until
// the swap completes).
export function keeperAssetName(kind, finalName, nowMs, random = randomBytes(4).toString("hex")) {
  return `${kind}-${String(nowMs).padStart(13, "0")}-${random}.${finalName}`;
}

export function parseKeeperAssetName(name) {
  const match = KEEPER_ASSET_PATTERN.exec(typeof name === "string" ? name : "");
  return match ? { kind: match[1], ms: Number(match[2]), finalName: match[3] } : null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  async function call(method, url, { body, contentType, okStatuses = [200], timeoutMs = GITHUB_CALL_TIMEOUT_MS } = {}) {
    const response = await fetchImpl(url, { method, headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) }, body, signal: AbortSignal.timeout(timeoutMs) });
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
      return call("POST", `${uploadBase}/repos/${repo}/releases/${releaseId}/assets?${query}`, { body: bytes, contentType: "application/octet-stream", okStatuses: [201], timeoutMs: 600_000 });
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

export const RENAME_RETRY_DELAYS_MS = [2_000, 5_000];

// Renames an asset, retrying transient failures. A 422 (the name is taken) is final.
async function renameWithRetry(github, id, name, label, sleep) {
  for (let attempt = 0; ; attempt += 1) {
    try { return await github.rename(id, name, label); }
    catch (error) {
      if (error.status === 422 || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error;
      await sleep(RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

// Publishes one snapshot as asset `name` if it is newer. The current asset is
// never deleted before the replacement is in place: the replacement is uploaded
// under a temporary name, the current asset is renamed aside, the replacement is
// renamed to `name`. The moved-aside copy is kept as a backup (another keeper's
// delete-then-upload can remove `name` at any time) and aged out later by
// repairAndCleanup. If the final rename fails, the old asset is renamed back; if
// even that fails, both copies are kept so the next cycle can restore the name.
// The swap is not started after `swapBy`, so it can finish or roll back before
// the job is killed.
export async function publishAsset({ github, tag, name, bytes, snapshot, expectedGenesis, requestStartedMs, now, log, warn = log, sleep = defaultSleep, swapBy = Infinity }) {
  let release = await github.release(tag);
  let current = release.assets.find((asset) => asset.name === name) ?? null;
  const first = decideReplace({ snapshot, asset: current, expectedGenesis, requestStartedMs });
  if (!first.publish) return { published: false, reason: first.reason };
  const label = formatLabel(snapshot.height, snapshot.genesis);
  const temp = await github.upload(release.id, keeperAssetName("next", name, now()), label, bytes);
  let aside = null;
  try {
    // Re-check right before the swap: another keeper may have published meanwhile.
    release = await github.release(tag);
    const latest = release.assets.find((asset) => asset.name === name) ?? null;
    if ((latest?.id ?? null) !== (current?.id ?? null)) {
      const again = decideReplace({ snapshot, asset: latest, expectedGenesis, requestStartedMs });
      if (!again.publish) { await github.remove(temp.id); return { published: false, reason: `another keeper published first: ${again.reason}` }; }
      current = latest;
    }
    if (now() > swapBy) {
      await github.remove(temp.id).catch(() => {});
      return { published: false, reason: "run deadline reached before the swap; left for the next run" };
    }
    if (current) {
      await renameWithRetry(github, current.id, keeperAssetName("prev", name, now()), current.label ?? "", sleep);
      aside = current;
    }
  } catch (error) {
    // `name` is untouched (the aside rename did not happen): drop the upload.
    await github.remove(temp.id).catch(() => {});
    throw error;
  }
  try {
    await renameWithRetry(github, temp.id, name, label, sleep);
  } catch (error) {
    if (error.status === 422) {
      // Another keeper put a new asset under `name` meanwhile: theirs stays. The
      // old copy (if any) is kept aside and cleaned up later.
      await github.remove(temp.id).catch(() => {});
      return { published: false, reason: "another keeper published the same name concurrently" };
    }
    if (aside) {
      try { await renameWithRetry(github, aside.id, name, aside.label ?? "", sleep); }
      catch (restoreError) {
        warn(`could not rename ${name} back (${restoreError.message}); keeping both copies for the next cycle to repair`);
        throw error;
      }
    }
    await github.remove(temp.id).catch(() => {});
    throw error;
  }
  log(`published ${name} height ${snapshot.height} genesis ${snapshot.genesis.slice(0, 12)} (${first.reason})`);
  return { published: true, reason: first.reason };
}

// Restores a missing restore name from this keeper's own copies (left by a
// crash or a failed swap), then deletes this keeper's copies older than
// KEEPER_ASSET_MAX_AGE_MS for names that exist, except the best copy of each
// name, which stays as a backup. The name is re-checked in a fresh listing
// right before any deletion. Nothing else is deleted.
export async function repairAndCleanup({ github, tag, expectedGenesis, now, log, warn = log, sleep = defaultSleep }) {
  const release = await github.release(tag);
  const present = new Set(release.assets.map((asset) => asset.name));
  const groups = new Map();
  for (const asset of release.assets) {
    const parsed = parseKeeperAssetName(asset.name);
    if (!parsed) continue;
    if (!groups.has(parsed.finalName)) groups.set(parsed.finalName, []);
    groups.get(parsed.finalName).push({ asset, ...parsed });
  }
  for (const [finalName, copies] of groups) {
    if (!present.has(finalName)) {
      const rank = (copy) => copyRank(copy, expectedGenesis);
      const best = [...copies].sort((a, b) => rank(b) - rank(a) || b.ms - a.ms)[0];
      if (rank(best) < 0 && best.kind !== "prev") continue;
      await renameWithRetry(github, best.asset.id, finalName, best.asset.label ?? "", sleep);
      warn(`restored missing ${finalName} from ${best.asset.name}`);
      copies.splice(copies.indexOf(best), 1);
    }
    // The best remaining copy is always kept as a backup (another keeper's
    // delete-then-upload may remove the name at any time and fail to replace
    // it). Older surplus copies are deleted only after a fresh listing shows
    // that the name still exists.
    const surplus = [...copies].sort((a, b) => copyRank(b, expectedGenesis) - copyRank(a, expectedGenesis) || b.ms - a.ms)
      .slice(1).filter((copy) => now() - copy.ms > KEEPER_ASSET_MAX_AGE_MS);
    if (!surplus.length) continue;
    const fresh = await github.release(tag);
    if (!fresh.assets.some((asset) => asset.name === finalName)) { warn(`${finalName} disappeared; keeping all keeper copies`); continue; }
    for (const copy of surplus) {
      await github.remove(copy.asset.id);
      log(`removed stale keeper copy ${copy.asset.name}`);
    }
  }
}

function copyRank(copy, expectedGenesis) {
  const label = parseLabel(copy.asset.label);
  return label && label.genesis === expectedGenesis ? label.height : -1;
}

// Reads a response body with a hard byte cap (checked before and while reading).
export async function readCapped(response, maxBytes) {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared.trim()) || Number(declared) > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`snapshot content-length ${JSON.stringify(declared)} is invalid or above ${maxBytes} bytes`);
  }
  const chunks = [];
  let total = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error(`snapshot body exceeds ${maxBytes} bytes`);
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks, total);
}

export async function fetchSnapshot({ fetchImpl, gateway, expectedGenesis, now }) {
  const requestStartedMs = now();
  const response = await fetchImpl(`${gateway}/state/snapshot`, { signal: AbortSignal.timeout(300_000) });
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`snapshot request returned HTTP ${response.status}`);
  }
  const bytes = await readCapped(response, MAX_SNAPSHOT_BYTES);
  const snapshot = validateSnapshot({ status: response.status, headers: response.headers, bytes }, expectedGenesis);
  return { snapshot, bytes, requestStartedMs };
}

// One keeper cycle: download, check, publish state.enc then the per-genesis copy.
export async function publishCycle({ fetchImpl, github, gateway, tag, expectedGenesis, now, log, warn = log, sleep = defaultSleep, swapBy = Infinity }) {
  const { snapshot, bytes, requestStartedMs } = await fetchSnapshot({ fetchImpl, gateway, expectedGenesis, now });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const main = await publishAsset({ github, tag, name: "state.enc", bytes, snapshot, expectedGenesis, requestStartedMs, now, log, warn, sleep, swapBy });
  const copy = await publishAsset({ github, tag, name: perGenesisName(snapshot.genesis), bytes, snapshot, expectedGenesis, requestStartedMs, now, log, warn, sleep, swapBy });
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

// Runs two independent loops until the deadline: /health every
// keepAliveIntervalMs (so a slow publish cycle never lets the instance idle)
// and a publish cycle every publishIntervalMs.
export async function runKeeper(options) {
  const { fetchImpl, github, gateway, tag, expectedGenesis, runMs, publishIntervalMs, keepAliveIntervalMs, now, sleep, log, warn } = options;
  const stats = { cycles: 0, published: 0, notNewer: 0, failures: 0, genesisMismatches: 0, lastPublishedHeight: null, lastHeight: null };
  const deadline = now() + runMs;
  const pause = async (intervalMs) => {
    const wait = Math.min(now() + intervalMs, deadline) - now();
    if (wait > 0) await sleep(wait);
  };
  const keepAliveLoop = async () => {
    while (now() < deadline) {
      const health = await keepAlive({ fetchImpl, gateway });
      log(`health HTTP ${health.status} ${health.phase}${health.height === null ? "" : ` height ${health.height}`}`);
      await pause(keepAliveIntervalMs);
    }
  };
  const publishLoop = async () => {
    while (now() < deadline) {
      stats.cycles += 1;
      try { await repairAndCleanup({ github, tag, expectedGenesis, now, log, warn, sleep }); }
      catch (error) { warn(`repair/cleanup of keeper copies failed: ${error instanceof Error ? error.message : String(error)}`); }
      try {
        const result = await publishCycle({ fetchImpl, github, gateway, tag, expectedGenesis, now, log, warn, sleep, swapBy: deadline });
        stats.lastHeight = result.height;
        if (result.published) { stats.published += 1; stats.lastPublishedHeight = result.height; log(`snapshot sha256 ${result.sha256} size ${result.size}`); }
        else stats.notNewer += 1;
      } catch (error) {
        if (error instanceof GenesisMismatchError) { stats.genesisMismatches += 1; warn(error.message); }
        else { stats.failures += 1; warn(`cycle failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      await pause(publishIntervalMs);
    }
  };
  await Promise.all([keepAliveLoop(), publishLoop()]);
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
