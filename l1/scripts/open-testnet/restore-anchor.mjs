// S2-3 trust anchor T1 for the open-testnet cold-start restore
// (docs/specs/s2-3-t1-sealed-summary.md). Builds the restoreAnchor that
// restoreNetwork requires ONLY from files pinned in the repository
// (l1/trust/, changed only by reviewed PR, read from the checkout of the
// release ref): the sealed summary itself, the summary keys, the append-only
// revoke/supersede record, the append-only high-water record, and the boot
// config (which validators form the live quorum). Nothing is taken
// from environment variables, command-line options, the snapshot bundle or
// the gateway. Nothing here holds or reads a private key. Every failure is a
// refusal with its own code (RestoreAnchorError, never a local I/O error).
import { lookup as dnsLookup } from "node:dns/promises";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const anchorApi = await import(join(l1Root, "dist/src/sealed-summary.js"));
const { RESTORE_ANCHOR_CODES: C, RestoreAnchorError, highWaterFor, isPrivateOrLoopbackHost, quorumSourceSite, parseHighWaterFile, parseRestoreAnchorConfig, parseTrustFileText, restoreTrustFromFiles } = anchorApi;
const { blockHash, validateBlockAttestation } = await import(join(l1Root, "dist/src/block.js"));
const { addressFromPublicKey } = await import(join(l1Root, "dist/src/crypto.js"));

export const DEFAULT_RESTORE_TRUST_DIR = join(l1Root, "trust");
export const RESTORE_TRUST_FILES = Object.freeze({
  keys: "t1-summary-keys.json",
  record: "t1-summary-record.json",
  highWater: "t1-high-water.json",
  seal: "t1-sealed-summary.txt",
  config: "restore-anchor-config.json"
});
export const MAX_SEAL_BYTES = 64 * 1024;
export const MAX_BLOCK_BYTES = 4 * 1024 * 1024;
// There is no runtime override of the trust directory (no env, option,
// global or preload seam): the boot always reads l1/trust/ next to this
// script, i.e. the checked-out release ref. Tests run a copy of the scripts
// in a temporary l1 tree whose trust/ holds fixture files.
export function bootRestoreTrustDir() { return DEFAULT_RESTORE_TRUST_DIR; }
// A fixture trust directory written by the local test helper may enable
// loopback quorum sources with this marker file. The repository's own
// l1/trust/ must never contain it (checked by t1-trust-append-only.mjs and the
// T1 tests).
export const LOOPBACK_FIXTURE_MARKER = "TEST-FIXTURE-ONLY-loopback-quorum";

// Every trust JSON file must be byte-canonical with no duplicate keys
// (parseTrustFileText: JSON.stringify(value, null, 2) plus one newline).
async function readJson(path, code, label) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { throw new RestoreAnchorError(code, `${label} is missing`); }
  return parseTrustFileText(text, label);
}

/** All pinned trust files of a directory, parsed strictly. */
export async function loadRestoreTrust(dir = DEFAULT_RESTORE_TRUST_DIR) {
  const keys = await readJson(join(dir, RESTORE_TRUST_FILES.keys), C.anchorConfigInvalid, "the pinned restore summary key file");
  const record = await readJson(join(dir, RESTORE_TRUST_FILES.record), C.anchorConfigInvalid, "the revoke/supersede record");
  const highWater = parseHighWaterFile(await readJson(join(dir, RESTORE_TRUST_FILES.highWater), C.anchorConfigInvalid, "the high-water record"));
  const allowLoopbackFixture = await access(join(dir, LOOPBACK_FIXTURE_MARKER)).then(() => true, () => false);
  const config = parseRestoreAnchorConfig(await readJson(join(dir, RESTORE_TRUST_FILES.config), C.anchorConfigInvalid, "the restore anchor config"), { allowLoopbackFixture });
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
 * Reads the sealed summary from the pinned repository file (published by PR).
 * A missing file means "nothing sealed" (null: RESTORE_SEAL_MISSING). The raw
 * text is returned unparsed (no trimming); the verifier parses it strictly.
 * Other failures throw (RESTORE_ANCHOR_UNAVAILABLE).
 */
export async function readSealFile(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return null; throw new Error("the sealed summary file is unreadable"); }
  if (Buffer.byteLength(text) > MAX_SEAL_BYTES) throw new Error("the sealed summary file is too large");
  return text;
}

/**
 * Live quorum tip at `height` from the pinned validators. Each source's
 * GET {url}/block/{height} must be a self-consistent block (hash over the
 * header, height, chain ID). A trusted validator counts toward the tip only
 * if its secp256k1 finality attestation on that block verifies. The tip needs
 * `threshold` distinct trusted validators, from sources on at least two
 * distinct sites (quorumSourceSite: registrable host, so one host, its ports
 * or its subdomains answering for every validator is not a quorum). A
 * second verified tip, a deadline, or too few verified attestations fail
 * closed, each with its own code.
 *
 * Before any request, every source host is resolved (all addresses); if any
 * address is private, loopback or otherwise non-public (isPrivateOrLoopbackHost)
 * the read is refused with RESTORE_ANCHOR_CONFIG_INVALID, so a public-looking
 * name that points at a private address (nip.io style) fails. Only the local
 * test fixture's http://127.0.0.1 sources (accepted by the config parser only
 * with the fixture marker) skip this. A lookup failure counts that source as
 * not answering. fetch resolves the name again, so this does not pin the
 * address against DNS rebinding between the check and the request; the
 * secp256k1 attestations, not the transport, are what the tip relies on.
 */
export async function assertPublicQuorumResolution(validators, { lookupImpl = dnsLookup, signal } = {}) {
  // A lookup is bounded by the reader's deadline (a hung resolver counts the
  // source as not answering; the fetch then reports the timeout).
  const bounded = (promise) => signal ? Promise.race([promise, new Promise((_, reject) => {
    if (signal.aborted) reject(new Error("deadline"));
    signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true });
  })]) : promise;
  const failed = new Set();
  await Promise.all(validators.map(async ({ url }) => {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" && parsed.hostname === "127.0.0.1") return;
    if (isPrivateOrLoopbackHost(parsed.hostname)) throw new RestoreAnchorError(C.anchorConfigInvalid, "a quorum source host is not public");
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    let addresses;
    try { addresses = await bounded(lookupImpl(host, { all: true, verbatim: true })); } catch { failed.add(url); return; }
    const list = Array.isArray(addresses) ? addresses : [addresses];
    if (list.length === 0) { failed.add(url); return; }
    for (const entry of list) {
      const address = typeof entry === "string" ? entry : entry?.address;
      if (typeof address !== "string" || isPrivateOrLoopbackHost(address)) {
        throw new RestoreAnchorError(C.anchorConfigInvalid, `the quorum source host ${parsed.hostname} resolves to a private, loopback or non-public address`);
      }
    }
  }));
  return failed;
}

export function quorumTipReader({ chainId, threshold, timeoutMs, validators }, { fetchImpl = fetch, lookupImpl = dnsLookup } = {}) {
  const allowed = new Map(validators.map((validator) => [addressFromPublicKey(validator.publicKey), validator.publicKey]));
  return async (height) => {
    if (validators.length === 0 || threshold < 1) throw new RestoreAnchorError(C.quorumTipUnavailable, "no live quorum validators are pinned");
    const deadline = AbortSignal.timeout(timeoutMs);
    const unresolved = await assertPublicQuorumResolution(validators, { lookupImpl, signal: deadline });
    const outcomes = await Promise.all(validators.map(async ({ url }) => {
      if (unresolved.has(url)) return { kind: "missing" };
      const origin = quorumSourceSite(url);
      try {
        const result = await fetchBounded(`${url.replace(/\/+$/, "")}/block/${height}`, { fetchImpl, signal: deadline, maxBytes: MAX_BLOCK_BYTES });
        if (result.status !== 200) return { kind: "missing" };
        const block = JSON.parse(result.text);
        if (block?.header?.height !== height || block.header.chainId !== chainId || typeof block.hash !== "string" || blockHash(block.header) !== block.hash || !Array.isArray(block.attestations)) return { kind: "unverified" };
        const attesters = new Set();
        for (const attestation of block.attestations) {
          try { validateBlockAttestation(block, attestation, allowed); attesters.add(attestation.publicKey); } catch { /* not a trusted, valid attestation */ }
        }
        return attesters.size > 0 && origin ? { kind: "verified", tipHash: block.hash, attesters, origin } : { kind: "unverified" };
      } catch (error) {
        return { kind: deadline.aborted || error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "missing" };
      }
    }));
    const byHash = new Map();
    for (const outcome of outcomes) {
      if (outcome.kind !== "verified") continue;
      const entry = byHash.get(outcome.tipHash) ?? { origins: new Set(), attesters: new Set() };
      entry.origins.add(outcome.origin);
      for (const key of outcome.attesters) entry.attesters.add(key);
      byHash.set(outcome.tipHash, entry);
    }
    if (byHash.size > 1) throw new RestoreAnchorError(C.quorumTipMismatch, `trusted validators report ${byHash.size} different verified tips at height ${height}`);
    const [tip] = [...byHash.entries()];
    if (tip && tip[1].attesters.size >= threshold && tip[1].origins.size >= 2) return { height, tipHash: tip[0] };
    if (outcomes.some((outcome) => outcome.kind === "timeout")) throw new RestoreAnchorError(C.quorumTipTimeout, `the live quorum did not answer within ${timeoutMs} ms`);
    if (outcomes.some((outcome) => outcome.kind === "unverified")) throw new RestoreAnchorError(C.quorumTipUnavailable, `fewer than ${threshold} trusted validator attestations verify at height ${height}`);
    throw new RestoreAnchorError(C.quorumTipUnavailable, `fewer than ${threshold} trusted validators answered for height ${height}`);
  };
}

/**
 * The boot restoreAnchor, from the pinned trust directory only. Throws
 * RESTORE_ANCHOR_CONFIG_INVALID for broken or incomplete files. With no
 * pinned key (the shipped placeholder) it throws RESTORE_ANCHOR_MISSING: the
 * boot then refuses and exits (it never creates a fresh genesis).
 */
export async function createRestoreAnchor({ chainId, trustDir = DEFAULT_RESTORE_TRUST_DIR, fetchImpl = fetch, lookupImpl = dnsLookup } = {}) {
  const trust = await loadRestoreTrust(trustDir);
  const { config } = trust;
  if (trust.pinnedKeys.length === 0) throw new RestoreAnchorError(C.anchorMissing, "no restore summary key is pinned in the repository (placeholder); a hosted restore is refused until one is pinned by PR");
  if (config.chainId !== chainId) throw new RestoreAnchorError(C.anchorConfigInvalid, "the restore anchor config is for another chain ID");
  if (config.quorum.validators.length === 0) throw new RestoreAnchorError(C.anchorConfigInvalid, "a summary key is pinned but no live quorum validators are configured");
  return {
    // Each read is bounded by the verifier; the quorum reader's own deadline
    // (config.quorum.timeoutMs) fires first so its timeout keeps its code.
    timeoutMs: config.quorum.timeoutMs + 1_000,
    pinnedKeys: trust.pinnedKeys,
    readSeal: () => readSealFile(join(trustDir, RESTORE_TRUST_FILES.seal)),
    readSuperseded: async () => structuredClone(trust.superseded),
    readHighWater: async () => highWaterFor(trust.highWater, chainId, trust.superseded),
    readQuorumTip: quorumTipReader({ chainId, threshold: config.quorum.threshold, timeoutMs: config.quorum.timeoutMs, validators: config.quorum.validators }, { fetchImpl, lookupImpl })
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
