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
//     only missing between two API calls and never lost. A failed rename
//     request is checked against a fresh listing (GitHub may have applied it);
//     when the listing fails, every copy is kept. A failed upload request is
//     checked the same way (the generated temporary name is known before the
//     POST), and so is repair's request to move an incomplete asset aside.
//     The upload is deleted after losing the name to another asset only when
//     that asset is complete, and never after a failed pre-swap listing. No upload, swap, repair rename or cleanup
//     delete starts after the run deadline, and no publication follows a repair
//     that ended after it, so a started swap ends before the job timeout;
//   - only this keeper's own next-/prev- copies are ever cleaned up; complete
//     ones only when the name they belong to exists (rechecked right before
//     deleting), and the best restorable copy of each name is always kept. An
//     incomplete asset (not in the `uploaded` state, or too small) is never
//     restored or kept, and a copy labeled for another genesis is never
//     restored. An incomplete `state.enc` is replaced or repaired;
//   - /health is polled until the publish loop stops, even past the deadline;
//     publish cycles start on a fixed interval from the previous cycle start.
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

// Resolves after `ms`, or as soon as `signal` aborts; the timer is cleared
// either way, so an abandoned wait never keeps the process alive.
export function cancellableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

const defaultSleep = cancellableSleep;

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
    return { publish: false, upToDate: true, reason: `not newer (published height ${label.height}, snapshot ${snapshot.height})` };
  }
  const updatedMs = Date.parse(asset.updated_at ?? "");
  if (!Number.isFinite(updatedMs)) return { publish: false, reason: "published asset has no usable updated_at" };
  if (requestStartedMs > updatedMs + UNLABELED_MARGIN_MS) return { publish: true, reason: `unlabeled asset from ${asset.updated_at}, snapshot requested later` };
  return { publish: false, reason: `unlabeled asset updated ${asset.updated_at} by another keeper moments ago` };
}

// decideReplace, except that a broken published asset (fully uploaded but too
// small, or a `starter` upload abandoned for STARTER_ABANDONED_MS; unusable for
// a restore) is always replaced, unless it is labeled for another genesis. A
// fresh `starter` asset may be another keeper's newer snapshot still uploading,
// so the normal rules apply to it.
function decidePublish({ snapshot, asset, expectedGenesis, requestStartedMs, nowMs }) {
  const decision = decideReplace({ snapshot, asset, expectedGenesis, requestStartedMs });
  if (decision.publish || !asset || !isBrokenCanonical(asset, nowMs) || snapshot.genesis !== expectedGenesis) return decision;
  const label = parseLabel(asset.label);
  if (label && label.genesis !== expectedGenesis) return decision;
  return { publish: true, reason: `published asset is incomplete (state ${asset.state}, ${asset.size} bytes)` };
}

export function createGitHub({ fetchImpl, token, repo, apiBase = "https://api.github.com", uploadBase = "https://uploads.github.com" }) {
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`invalid repository ${repo}`);
  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "zyron-open-testnet-snapshot-keeper" };
  async function call(method, url, { body, contentType, okStatuses = [200], timeoutMs = GITHUB_CALL_TIMEOUT_MS, signal = AbortSignal.timeout(timeoutMs) } = {}) {
    const response = await fetchImpl(url, { method, headers: { ...headers, ...(contentType ? { "content-type": contentType } : {}) }, body, signal });
    const text = await response.text();
    if (!okStatuses.includes(response.status)) {
      const error = new Error(`${method} ${url.replace(/\?.*$/, "")} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      error.status = response.status;
      throw error;
    }
    return text ? JSON.parse(text) : null;
  }
  return {
    // One timeout covers the whole listing (every page), so a listing counts as
    // a single GitHub call in the swap time budget.
    async release(tag) {
      const signal = AbortSignal.timeout(GITHUB_CALL_TIMEOUT_MS);
      const release = await call("GET", `${apiBase}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { signal });
      const assets = [];
      for (let page = 1; page <= 10; page += 1) {
        const batch = await call("GET", `${apiBase}/repos/${repo}/releases/${release.id}/assets?per_page=100&page=${page}`, { signal });
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
  const first = decidePublish({ snapshot, asset: current, expectedGenesis, requestStartedMs, nowMs: now() });
  if (!first.publish) return { published: false, upToDate: first.upToDate === true, reason: first.reason };
  if (now() > swapBy) return { published: false, reason: "run deadline reached before the upload; left for the next run" };
  const label = formatLabel(snapshot.height, snapshot.genesis);
  // The temporary name is fixed before the POST, so an upload whose response
  // was lost can still be found and installed.
  const tempName = keeperAssetName("next", name, now());
  let temp;
  try {
    temp = await github.upload(release.id, tempName, label, bytes);
  } catch (error) {
    temp = await findCompletedUpload({ github, tag, tempName, label, size: bytes.length, warn });
    if (!temp) throw error;
    warn(`the upload of ${tempName} reported an error (${error.message}) but the listing shows it complete; continuing the swap`);
  }
  let aside = null;
  let asideAttempted = false;
  let asideName = null;
  // Set when the old asset vanished: there is nothing to roll back to, so a
  // failed final rename keeps the upload for repair instead of deleting it.
  let keepUpload = false;
  try {
    // Re-check right before the swap: another keeper may have published meanwhile.
    release = await github.release(tag);
    const latest = release.assets.find((asset) => asset.name === name) ?? null;
    if ((latest?.id ?? null) !== (current?.id ?? null)) {
      const again = decidePublish({ snapshot, asset: latest, expectedGenesis, requestStartedMs, nowMs: now() });
      if (!again.publish) {
        // The upload is dropped only in favour of a complete asset: one that is
        // still being uploaded may never complete, and the upload may then be
        // the only usable copy (repair installs it once the other is abandoned).
        if (!isCompleteAsset(latest)) {
          warn(`${name} is now held by an incomplete asset (state ${latest?.state}, ${latest?.size} bytes), probably an upload in progress; keeping the upload ${temp.name ?? temp.id} for the next cycle to repair`);
          return { published: false, reason: `another keeper's upload is in progress: ${again.reason}; upload kept for repair` };
        }
        await github.remove(temp.id).catch(() => {});
        return { published: false, upToDate: again.upToDate === true, reason: `another keeper published first: ${again.reason}` };
      }
      current = latest;
    }
    if (now() > swapBy) {
      await github.remove(temp.id).catch(() => {});
      return { published: false, reason: "run deadline reached before the swap; left for the next run" };
    }
    if (current) {
      asideAttempted = true;
      asideName = keeperAssetName("prev", name, now());
      await renameWithRetry(github, current.id, asideName, current.label ?? "", sleep);
      aside = current;
    }
  } catch (error) {
    if (!asideAttempted) {
      // The pre-swap listing failed: it shows neither that `name` exists nor
      // that dropping the upload is safe, so the upload stays for repair.
      warn(`could not re-check ${name} before the swap (${error.message}); keeping the upload ${temp.name ?? temp.id} for the next cycle to repair`);
      throw error;
    }
    if (error.status === 422) {
      // `name` is untouched (the aside rename did not happen): drop the upload.
      await github.remove(temp.id).catch(() => {});
      throw error;
    }
    // A failed request does not prove that GitHub did not apply the rename (the
    // response can be lost). Look at a fresh listing before touching anything.
    let listing;
    try { listing = await github.release(tag); }
    catch (listError) {
      warn(`could not verify the rename of ${name} aside (${listError.message}); keeping the upload ${temp.name ?? temp.id} for the next cycle to repair`);
      throw error;
    }
    const old = listing.assets.find((asset) => asset.id === current.id) ?? null;
    if (old?.name === name) {
      // `name` is still the old asset: the rename did not happen. Drop the upload.
      await github.remove(temp.id).catch(() => {});
      throw error;
    }
    if (old?.name !== asideName) {
      // The old asset vanished (another keeper deleted it) or was renamed by
      // someone else: it is not this keeper's backup and is never renamed back.
      // The name is probably free now, so the upload is renamed into place at
      // once (a concurrent upload of the name makes that a harmless 422); if
      // that fails, the upload stays as a keeper copy for repair.
      warn(`${name} vanished during the swap (${old ? `now ${old.name}` : "deleted"}); renaming the upload into place`);
      keepUpload = true;
    } else {
      warn(`renaming ${name} aside reported an error but the listing shows it moved; completing the swap`);
      aside = old;
    }
  }
  try {
    await renameWithRetry(github, temp.id, name, label, sleep);
  } catch (error) {
    // As with the aside rename, GitHub may have applied the final rename and
    // lost the response, and a 422 only says that some asset held the name at
    // that moment. Nothing is renamed back or deleted until a fresh listing
    // shows what is under the name.
    const collided = error.status === 422;
    let listing;
    try { listing = await github.release(tag); }
    catch (listError) {
      warn(`could not verify the rename of the upload to ${name} (${listError.message}); keeping every copy for the next cycle to repair`);
      if (collided) return { published: false, reason: "the name was taken concurrently and the listing could not be checked; every copy kept for repair" };
      throw error;
    }
    if (listing.assets.some((asset) => asset.id === temp.id && asset.name === name)) {
      warn(`renaming the upload to ${name} reported an error but the listing shows it in place`);
      log(`published ${name} height ${snapshot.height} genesis ${snapshot.genesis.slice(0, 12)} (${first.reason})`);
      return { published: true, reason: first.reason };
    }
    const holder = listing.assets.find((asset) => asset.name === name && asset.id !== temp.id) ?? null;
    if (holder) {
      // Another keeper put an asset under `name` meanwhile; theirs keeps the
      // name and the old copy (if any) stays aside for cleanup. The upload is
      // deleted only when their asset is complete: an asset that is still
      // being uploaded (`starter`) may never complete, and the upload may then
      // be the only usable copy, which repair installs once theirs is abandoned.
      if (isCompleteAsset(holder)) {
        await github.remove(temp.id).catch(() => {});
        if (collided) return { published: false, reason: "another keeper published the same name concurrently" };
        throw error;
      }
      warn(`${name} is held by an incomplete asset (state ${holder.state}, ${holder.size} bytes), probably an upload in progress; keeping the upload ${temp.name ?? temp.id} for the next cycle to repair`);
      if (collided) return { published: false, reason: "another keeper's upload of the same name is in progress; upload kept for repair" };
      throw error;
    }
    if (keepUpload || !aside) {
      // No asset holds the name and there is no moved-aside copy to put back:
      // the upload is the only complete copy, so it stays for repair.
      warn(`could not rename the upload to ${name} (${error.message}); keeping the upload ${temp.name ?? temp.id} for the next cycle to repair`);
      throw error;
    }
    try { await renameWithRetry(github, aside.id, name, aside.label ?? "", sleep); }
    catch (restoreError) {
      warn(`could not rename ${name} back (${restoreError.message}); keeping both copies for the next cycle to repair`);
      throw error;
    }
    await github.remove(temp.id).catch(() => {});
    throw error;
  }
  log(`published ${name} height ${snapshot.height} genesis ${snapshot.genesis.slice(0, 12)} (${first.reason})`);
  return { published: true, reason: first.reason };
}

// After a failed upload request: the upload under `tempName` if a fresh listing
// shows it complete with this upload's label and size (GitHub stored it and the
// response was lost), otherwise null. Anything else is left to repair.
async function findCompletedUpload({ github, tag, tempName, label, size, warn }) {
  let listing;
  try { listing = await github.release(tag); }
  catch (listError) {
    warn(`could not check whether the failed upload of ${tempName} was stored (${listError.message})`);
    return null;
  }
  const stored = listing.assets.find((asset) => asset.name === tempName) ?? null;
  if (!stored || !isCompleteAsset(stored) || stored.size !== size || (stored.label ?? "") !== label) return null;
  return stored;
}

// Restores a missing or incomplete restore name from this keeper's own copies
// (left by a crash, a failed swap, or another keeper's failed upload), then
// deletes this keeper's copies older than KEEPER_ASSET_MAX_AGE_MS, except the
// best restorable copy of each name, which stays as a backup. Complete copies
// are deleted only while the name exists (re-checked in a fresh listing right
// before deleting); stale incomplete copies are unusable and are deleted even
// while it is missing. Nothing else is deleted.
export async function repairAndCleanup({ github, tag, expectedGenesis, now, log, warn = log, sleep = defaultSleep, swapBy = Infinity }) {
  const release = await github.release(tag);
  // Like a swap, no repair or cleanup step starts after the run deadline.
  const pastDeadline = () => {
    if (now() <= swapBy) return false;
    warn("run deadline reached; leaving keeper copy repair and cleanup for the next run");
    return true;
  };
  const groups = new Map();
  for (const asset of release.assets) {
    const parsed = parseKeeperAssetName(asset.name);
    if (!parsed) continue;
    if (!groups.has(parsed.finalName)) groups.set(parsed.finalName, []);
    groups.get(parsed.finalName).push({ asset, ...parsed });
  }
  for (const [finalName, copies] of groups) {
    const ranked = [...copies].sort((a, b) => copyRank(b, expectedGenesis) - copyRank(a, expectedGenesis) || b.ms - a.ms);
    const restorable = ranked.filter((copy) => isRestorableCopy(copy, expectedGenesis));
    const canonical = release.assets.find((asset) => asset.name === finalName) ?? null;
    if (!canonical || isBrokenCanonical(canonical, now())) {
      const best = restorable[0];
      if (!best) {
        warn(`${finalName} is ${canonical ? "incomplete" : "missing"} and no complete keeper copy of the expected genesis exists to restore it`);
      } else {
        if (pastDeadline()) return;
        if (canonical) {
          // Move the unusable asset aside (never delete the canonical name's
          // asset); it is an incomplete keeper copy from then on and is cleaned
          // up once stale.
          try {
            await renameWithRetry(github, canonical.id, keeperAssetName("prev", finalName, now()), canonical.label ?? "", sleep);
          } catch (error) {
            if (error.status === 422) throw error;
            // GitHub may have applied the rename and lost the response: the
            // backup is installed only when a fresh listing shows the name free.
            const check = await github.release(tag);
            if (check.assets.some((asset) => asset.name === finalName)) throw error;
            warn(`moving incomplete ${finalName} aside reported an error (${error.message}) but the listing shows the name free`);
          }
          warn(`moved incomplete ${finalName} (state ${canonical.state}, ${canonical.size} bytes) aside`);
        }
        await renameWithRetry(github, best.asset.id, finalName, best.asset.label ?? "", sleep);
        warn(`restored ${canonical ? "incomplete" : "missing"} ${finalName} from ${best.asset.name}`);
        copies.splice(copies.indexOf(best), 1);
        restorable.shift();
      }
    }
    // The best remaining restorable copy is always kept as a backup (another
    // keeper's delete-then-upload may remove the name at any time and fail to
    // replace it). An incomplete copy is never the backup.
    const backup = restorable.find((copy) => copies.includes(copy));
    const surplus = ranked.filter((copy) => copies.includes(copy) && copy !== backup && now() - copy.ms > KEEPER_ASSET_MAX_AGE_MS);
    if (!surplus.length) continue;
    if (pastDeadline()) return;
    const fresh = await github.release(tag);
    const nameExists = fresh.assets.some((asset) => asset.name === finalName);
    const doomed = nameExists ? surplus : surplus.filter((copy) => !isCompleteAsset(copy.asset));
    if (!nameExists) warn(`${finalName} disappeared; keeping every complete keeper copy`);
    for (const copy of doomed) {
      if (pastDeadline()) return;
      await github.remove(copy.asset.id);
      log(`removed stale keeper copy ${copy.asset.name}`);
    }
  }
}

// An asset that is still being uploaded is in the `starter` state; an upload
// is given this long (longer than the 10-minute upload timeout) before an
// incomplete canonical asset counts as abandoned.
export const STARTER_ABANDONED_MS = 15 * 60_000;

// The canonical asset is broken when it is unusable for a restore: fully
// uploaded but too small, or still `starter` long after it was created.
function isBrokenCanonical(asset, nowMs) {
  if (!isProvablyIncomplete(asset)) return false;
  if (asset.state !== "starter") return true;
  const updatedMs = Date.parse(asset.updated_at ?? "");
  return Number.isFinite(updatedMs) && nowMs - updatedMs > STARTER_ABANDONED_MS;
}

// A copy may be renamed into place when it is complete and either labeled for
// the expected genesis or a moved-aside copy without a label (a legacy keeper
// asset). A copy labeled for another genesis is never restored.
function isRestorableCopy(copy, expectedGenesis) {
  if (!isCompleteAsset(copy.asset)) return false;
  const label = parseLabel(copy.asset.label);
  return label ? label.genesis === expectedGenesis : copy.kind === "prev";
}

// A release asset is usable only when GitHub reports it fully uploaded and it is
// large enough to be a sealed snapshot. A failed upload (for example an upstream
// 502) can leave an empty asset in the `starter` state.
export function isCompleteAsset(asset) {
  return asset?.state === "uploaded" && Number.isSafeInteger(asset.size) && asset.size > SNAPSHOT_HEADER.length + 28;
}

// An asset GitHub reports as not fully uploaded, or as too small to be a sealed
// snapshot. Only such positive evidence lets a published asset be replaced
// regardless of its height or moved aside by repair (isCompleteAsset, which
// requires positive evidence of completeness, decides what may be restored).
function isProvablyIncomplete(asset) {
  return (typeof asset?.state === "string" && asset.state !== "uploaded") || (Number.isSafeInteger(asset?.size) && asset.size <= SNAPSHOT_HEADER.length + 28);
}

// Ranks this keeper's copies: the labeled height for complete copies of the
// expected genesis, -1 for other complete copies, -2 for incomplete ones (never
// restored and never kept as the backup).
function copyRank(copy, expectedGenesis) {
  if (!isCompleteAsset(copy.asset)) return -2;
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
  // The state.enc result stands even when the per-genesis copy fails.
  let copy;
  try { copy = await publishAsset({ github, tag, name: perGenesisName(snapshot.genesis), bytes, snapshot, expectedGenesis, requestStartedMs, now, log, warn, sleep, swapBy }); }
  catch (error) {
    warn(`publishing ${perGenesisName(snapshot.genesis)} failed: ${error instanceof Error ? error.message : String(error)}`);
    copy = { published: false, reason: "failed" };
  }
  if (!main.published) log(`state.enc not replaced: ${main.reason}`);
  if (!copy.published) log(`${perGenesisName(snapshot.genesis)} not replaced: ${copy.reason}`);
  return { height: snapshot.height, genesis: snapshot.genesis, sha256, size: bytes.length, published: main.published, upToDate: !main.published && main.upToDate === true, copyPublished: copy.published, reason: main.reason };
}

// `signal` (optional) aborts the request early, for example when the keeper stops.
export async function keepAlive({ fetchImpl, gateway, signal }) {
  try {
    const timeout = AbortSignal.timeout(90_000);
    const response = await fetchImpl(`${gateway}/health`, { signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
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
  const stats = { cycles: 0, published: 0, notNewer: 0, refused: 0, failures: 0, genesisMismatches: 0, lastPublishedHeight: null, lastHeight: null };
  const deadline = now() + runMs;
  // Aborted when the publish loop stops, so no pending wait (and no live timer)
  // outlives runKeeper.
  const stop = new AbortController();
  // Waits until `untilMs` (capped at the deadline).
  const pauseUntil = async (untilMs) => {
    const wait = Math.min(untilMs, deadline) - now();
    if (wait > 0) await sleep(wait, stop.signal);
  };
  // Health is polled until the publish loop has stopped, not just until the
  // deadline: a cycle that started before the deadline can still be uploading.
  let publishStopped = false;
  let markStopped;
  const stopped = new Promise((resolve) => { markStopped = resolve; });
  const keepAliveLoop = async () => {
    while (!publishStopped) {
      // The stop signal also aborts a request still in flight when publishing stops.
      const health = await keepAlive({ fetchImpl, gateway, signal: stop.signal });
      log(`health HTTP ${health.status} ${health.phase}${health.height === null ? "" : ` height ${health.height}`}`);
      if (publishStopped) break;
      await Promise.race([sleep(keepAliveIntervalMs, stop.signal), stopped]);
    }
  };
  const publishLoop = async () => {
    while (now() < deadline) {
      // Cycles start every publishIntervalMs measured from the previous cycle
      // start; a cycle that overran the interval is followed immediately.
      const cycleStartedMs = now();
      stats.cycles += 1;
      try { await repairAndCleanup({ github, tag, expectedGenesis, now, log, warn, sleep, swapBy: deadline }); }
      catch (error) { warn(`repair/cleanup of keeper copies failed: ${error instanceof Error ? error.message : String(error)}`); }
      // A repair that started before the deadline can end after it; no
      // download or upload starts then.
      if (now() >= deadline) { warn("run deadline reached during repair; skipping publication"); break; }
      try {
        const result = await publishCycle({ fetchImpl, github, gateway, tag, expectedGenesis, now, log, warn, sleep, swapBy: deadline });
        stats.lastHeight = result.height;
        if (result.published) { stats.published += 1; stats.lastPublishedHeight = result.height; log(`snapshot sha256 ${result.sha256} size ${result.size}`); }
        else if (result.upToDate) stats.notNewer += 1;
        else { stats.refused += 1; warn(`state.enc not replaced: ${result.reason}`); }
      } catch (error) {
        if (error instanceof GenesisMismatchError) { stats.genesisMismatches += 1; warn(error.message); }
        else { stats.failures += 1; warn(`cycle failed: ${error instanceof Error ? error.message : String(error)}`); }
      }
      await pauseUntil(cycleStartedMs + publishIntervalMs);
    }
  };
  await Promise.all([keepAliveLoop(), publishLoop().finally(() => { publishStopped = true; markStopped(); stop.abort(); })]);
  return stats;
}

// Exit status: fail on any genesis mismatch, or when the whole run published
// nothing and never saw an up-to-date published asset (gateway or upload broken,
// or every publication refused for a safety reason such as a foreign-genesis label).
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
    now: Date.now, sleep: cancellableSleep,
    log: (line) => console.log(`${stamp()} ${line}`),
    warn: (line) => console.log(`::warning::${stamp()} ${line}`)
  });
  console.log(`${stamp()} done ${JSON.stringify(stats)}`);
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, `### Open testnet snapshot keeper\n\n| cycles | published | not newer | refused | failures | genesis mismatches | last published height | last seen height |\n|---|---|---|---|---|---|---|---|\n| ${stats.cycles} | ${stats.published} | ${stats.notNewer} | ${stats.refused} | ${stats.failures} | ${stats.genesisMismatches} | ${stats.lastPublishedHeight ?? "-"} | ${stats.lastHeight ?? "-"} |\n`);
  }
  process.exitCode = exitCodeFor(stats);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => { console.error(`::error::${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
