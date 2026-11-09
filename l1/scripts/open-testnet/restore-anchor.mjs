// S2-3 trust anchor T1 for the open-testnet cold-start restore
// (docs/specs/s2-3-t1-sealed-summary.md). Builds the restoreAnchor that
// restoreNetwork requires ONLY from files pinned in the repository
// (l1/trust/): the summary keys, the append-only revoke/supersede record, the
// append-only high-water record, and the boot config (where the seal is
// published and which validators form the live quorum). Nothing is taken
// from environment variables, command-line options, the snapshot bundle or
// the gateway. Nothing here holds or reads a private key. Every failure is a
// refusal with its own code (RestoreAnchorError, never a local I/O error).
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const anchorApi = await import(join(l1Root, "dist/src/sealed-summary.js"));
const { RESTORE_ANCHOR_CODES: C, RestoreAnchorError, highWaterFor, parseCanonicalSealText, parseHighWaterFile, parseRestoreAnchorConfig, restoreTrustFromFiles } = anchorApi;
const { blockHash, validateBlockAttestation } = await import(join(l1Root, "dist/src/block.js"));
const { addressFromPublicKey } = await import(join(l1Root, "dist/src/crypto.js"));

export const DEFAULT_RESTORE_TRUST_DIR = join(l1Root, "trust");
export const RESTORE_TRUST_FILES = Object.freeze({
  keys: "t1-summary-keys.json",
  record: "t1-summary-record.json",
  highWater: "t1-high-water.json",
  config: "restore-anchor-config.json"
});
export const MAX_SEAL_BYTES = 64 * 1024;
export const MAX_BLOCK_BYTES = 4 * 1024 * 1024;
// Test seam: a test preload (node --import) may point the boot at a fixture
// trust directory. It is not reachable from the environment, the command line
// or the network; code that can set it can already run anything in-process.
export const TEST_TRUST_DIR_SYMBOL = Symbol.for("zyronchain.open-testnet.test-restore-trust-dir");
export function bootRestoreTrustDir() {
  const override = globalThis[TEST_TRUST_DIR_SYMBOL];
  return typeof override === "string" && override.length > 0 ? resolve(override) : DEFAULT_RESTORE_TRUST_DIR;
}

async function readJson(path, code, label) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { throw new RestoreAnchorError(code, `${label} is missing`); }
  try { return JSON.parse(text); } catch { throw new RestoreAnchorError(code, `${label} is not JSON`); }
}

/** All pinned trust files of a directory, parsed strictly. */
export async function loadRestoreTrust(dir = DEFAULT_RESTORE_TRUST_DIR) {
  const keys = await readJson(join(dir, RESTORE_TRUST_FILES.keys), C.recordInvalid, "the pinned restore summary key file");
  const record = await readJson(join(dir, RESTORE_TRUST_FILES.record), C.recordInvalid, "the revoke/supersede record");
  const highWater = parseHighWaterFile(await readJson(join(dir, RESTORE_TRUST_FILES.highWater), C.recordInvalid, "the high-water record"));
  const config = parseRestoreAnchorConfig(await readJson(join(dir, RESTORE_TRUST_FILES.config), C.configInvalid, "the restore anchor config"));
  return { ...restoreTrustFromFiles(keys, record), highWater, config };
}

async function fetchBounded(url, { fetchImpl, signal, maxBytes }) {
  const response = await fetchImpl(url, { signal, redirect: "error" });
  if (response.status === 404) { await response.body?.cancel?.(); return { status: 404 }; }
  if (response.status !== 200) { await response.body?.cancel?.(); throw new Error(`HTTP ${response.status}`); }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) throw new Error("response too large");
  return { status: 200, text: bytes.toString("utf8") };
}

/**
 * Reads the published seal from the pinned sealUrl. No sealUrl, a 404 or a
 * missing file means "nothing sealed" (null: RESTORE_SEAL_MISSING). The text
 * must be its own canonical encoding (RESTORE_SEAL_NOT_CANONICAL). Other
 * failures throw (RESTORE_ANCHOR_UNAVAILABLE).
 */
export async function readSealFrom(sealUrl, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
  if (!sealUrl) return null;
  let text;
  if (sealUrl.startsWith("file:///")) {
    try { text = await readFile(fileURLToPath(sealUrl), "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw new Error("seal file unreadable"); }
    if (Buffer.byteLength(text) > MAX_SEAL_BYTES) throw new Error("seal file too large");
  } else {
    const result = await fetchBounded(sealUrl, { fetchImpl, signal: AbortSignal.timeout(timeoutMs), maxBytes: MAX_SEAL_BYTES });
    if (result.status === 404) return null;
    text = result.text;
  }
  return parseCanonicalSealText(text);
}

/**
 * Live quorum tip at `height` from the pinned validators. Each source's
 * GET {url}/block/{height} must be a self-consistent block (hash over the
 * header, height, chain ID). A trusted validator counts toward the tip only
 * if its secp256k1 finality attestation on that block verifies. The tip needs
 * `threshold` distinct trusted validators, from at least two sources. A
 * second verified tip, a deadline, or too few verified attestations fail
 * closed, each with its own code.
 */
export function quorumTipReader({ chainId, threshold, timeoutMs, validators }, { fetchImpl = fetch } = {}) {
  const allowed = new Map(validators.map((validator) => [addressFromPublicKey(validator.publicKey), validator.publicKey]));
  return async (height) => {
    if (validators.length === 0 || threshold < 1) throw new RestoreAnchorError(C.quorumTipUnavailable, "no live quorum validators are pinned");
    const deadline = AbortSignal.timeout(timeoutMs);
    const outcomes = await Promise.all(validators.map(async ({ url }) => {
      try {
        const result = await fetchBounded(`${url.replace(/\/+$/, "")}/block/${height}`, { fetchImpl, signal: deadline, maxBytes: MAX_BLOCK_BYTES });
        if (result.status !== 200) return { kind: "missing" };
        const block = JSON.parse(result.text);
        if (block?.header?.height !== height || block.header.chainId !== chainId || typeof block.hash !== "string" || blockHash(block.header) !== block.hash || !Array.isArray(block.attestations)) return { kind: "unverified" };
        const attesters = new Set();
        for (const attestation of block.attestations) {
          try { validateBlockAttestation(block, attestation, allowed); attesters.add(attestation.publicKey); } catch { /* not a trusted, valid attestation */ }
        }
        return attesters.size > 0 ? { kind: "verified", tipHash: block.hash, attesters } : { kind: "unverified" };
      } catch (error) {
        return { kind: deadline.aborted || error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "missing" };
      }
    }));
    const byHash = new Map();
    for (const outcome of outcomes) {
      if (outcome.kind !== "verified") continue;
      const entry = byHash.get(outcome.tipHash) ?? { sources: 0, attesters: new Set() };
      entry.sources += 1;
      for (const key of outcome.attesters) entry.attesters.add(key);
      byHash.set(outcome.tipHash, entry);
    }
    if (byHash.size > 1) throw new RestoreAnchorError(C.quorumTipMismatch, `trusted validators report ${byHash.size} different verified tips at height ${height}`);
    const [tip] = [...byHash.entries()];
    if (tip && tip[1].attesters.size >= threshold && tip[1].sources >= 2) return { height, tipHash: tip[0] };
    if (outcomes.some((outcome) => outcome.kind === "timeout")) throw new RestoreAnchorError(C.quorumTipTimeout, `the live quorum did not answer within ${timeoutMs} ms`);
    if (outcomes.some((outcome) => outcome.kind === "unverified")) throw new RestoreAnchorError(C.quorumTipUnverified, `fewer than ${threshold} trusted validator attestations verify at height ${height}`);
    throw new RestoreAnchorError(C.quorumTipUnavailable, `fewer than ${threshold} trusted validators answered for height ${height}`);
  };
}

/**
 * The boot restoreAnchor, from the pinned trust directory only. Throws
 * RESTORE_ANCHOR_RECORD_INVALID / RESTORE_ANCHOR_CONFIG_INVALID for broken or
 * incomplete files. With no pinned key (the shipped placeholder) the restore
 * is refused with RESTORE_ANCHOR_MISSING.
 */
export async function createRestoreAnchor({ chainId, trustDir = DEFAULT_RESTORE_TRUST_DIR, fetchImpl = fetch } = {}) {
  const trust = await loadRestoreTrust(trustDir);
  const { config } = trust;
  if (trust.pinnedKeys.length > 0) {
    if (config.chainId !== chainId) throw new RestoreAnchorError(C.configInvalid, "the restore anchor config is for another chain ID");
    if (!config.sealUrl) throw new RestoreAnchorError(C.configInvalid, "a summary key is pinned but no sealUrl is configured");
    if (config.quorum.validators.length === 0) throw new RestoreAnchorError(C.configInvalid, "a summary key is pinned but no live quorum validators are configured");
  }
  return {
    pinnedKeys: trust.pinnedKeys,
    readSeal: () => readSealFrom(config.sealUrl, { fetchImpl }),
    readSuperseded: async () => structuredClone(trust.superseded),
    readHighWater: async () => highWaterFor(trust.highWater, chainId),
    readQuorumTip: quorumTipReader({ chainId, threshold: config.quorum.threshold, timeoutMs: config.quorum.timeoutMs, validators: config.quorum.validators }, { fetchImpl })
  };
}

/**
 * Summary builder over validators' own finalized logs (smoke and local
 * fixtures): `logPaths` are blocks.ndjson files of distinct validators; the
 * tip at `height` must be a quorum match across them, and the state fields
 * come from replaying an agreeing validator's own log into `workDir` (never
 * from a snapshot).
 */
export async function summaryFromValidatorLogs({ genesis, genesisHash, logPaths, height, workDir, provenance, sealedAtMs = Date.now() }) {
  const { ChainStore } = await import(join(l1Root, "dist/src/storage.js"));
  const logs = await Promise.all(logPaths.map(async (path) => (await readFile(path, "utf8")).split("\n").filter(Boolean)));
  const reports = logs.map((lines, index) => {
    const line = lines[height - 1];
    if (!line) return undefined;
    const block = JSON.parse(line);
    return { source: String(index), height: block.header?.height, tipHash: block.hash };
  });
  const quorumTip = anchorApi.quorumTipFromReports(height, reports, logPaths.length);
  const agreeing = reports.findIndex((report) => report?.tipHash === quorumTip.tipHash);
  return { summary: await summaryFromLog({ genesis, genesisHash, lines: logs[agreeing].slice(0, height), workDir, quorumTip, provenance, sealedAtMs, ChainStore }), quorumTip };
}

/** Replays one validator's own log lines into `workDir` and builds the summary against a quorum tip. */
export async function summaryFromLog({ genesis, genesisHash, lines, workDir, quorumTip, provenance, sealedAtMs = Date.now(), ChainStore }) {
  ChainStore ??= (await import(join(l1Root, "dist/src/storage.js"))).ChainStore;
  const store = await ChainStore.open(genesis, workDir);
  try {
    for (const line of lines) await store.commitFinalizedBlock(typeof line === "string" ? JSON.parse(line) : line);
    return anchorApi.buildRestoreSummary({ chainId: genesis.chainId, genesisHash, chain: store.chain, quorumTip, validators: genesis.validators, activityOracles: genesis.activityOracles, provenance, sealedAtMs });
  } finally { store.close?.(); }
}
