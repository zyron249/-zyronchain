#!/usr/bin/env node
// S2-3 trust anchor T1 summary builder (docs/specs/s2-3-t1-sealed-summary.md).
// Holds no key and reads no key.
//
//   build      --network-dir <dir> --validator v1 --height <h> --publisher <text> --workflow <text> --commit <40 hex> [--trust-dir l1/trust]
//              Reads the live quorum tip at <h> from the validators pinned in
//              <trust-dir>/restore-anchor-config.json (each block's secp256k1
//              finality attestations verified, at least `threshold` distinct
//              trusted validators), replays this validator's OWN finalized log
//              (<network-dir>/data-<validator>/blocks.ndjson) to <h>, and prints
//              the summary JSON. Refuses unless the replayed tip equals the live
//              quorum tip. Never reads a snapshot.
//   assemble   --summary <summary.json> --key-id <id> --signature <hex>
//              Prints the raw seal text (canonicalJson({ keyId, signature, summary }),
//              no trailing newline) for l1/trust/t1-sealed-summary.txt, after
//              checking the signature against the keys pinned in <trust-dir>.
//   high-water --summary <summary.json> --key-id <id> --reason <text> [--trust-dir l1/trust]
//              Prints l1/trust/t1-high-water.json with this seal appended (the
//              same PR publishes the seal and its high-water entry).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const api = await import(join(l1Root, "dist/src/sealed-summary.js"));
const { canonicalJson } = await import(join(l1Root, "dist/src/codec.js"));
const { ZyronChain } = await import(join(l1Root, "dist/src/chain.js"));
const anchor = await import("./open-testnet/restore-anchor.mjs");

function options(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i] ?? "") || typeof argv[i + 1] !== "string") throw new Error(`bad argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const need = (o, name) => { if (!o[name]) throw new Error(`--${name} is required`); return o[name]; };
const readJson = async (path) => JSON.parse(await readFile(resolve(path), "utf8"));

// fetchImpl undefined: the quorum reader uses its DNS-pinned fetch.
export async function buildFromLiveQuorum(o, { fetchImpl } = {}) {
  const trustDir = resolve(o["trust-dir"] ?? anchor.DEFAULT_RESTORE_TRUST_DIR);
  const networkDir = resolve(need(o, "network-dir"));
  const validator = need(o, "validator");
  if (!/^v[1-4]$/.test(validator)) throw new Error("--validator must be v1..v4");
  const height = Number(need(o, "height"));
  const genesis = await readJson(join(networkDir, "genesis.json"));
  const trust = await anchor.loadRestoreTrust(trustDir);
  if (trust.config.chainId !== genesis.chainId) throw new Error("the pinned restore anchor config is for another chain ID");
  const readQuorumTip = anchor.quorumTipReader({ chainId: genesis.chainId, ...trust.config.quorum }, { fetchImpl });
  const quorumTip = await readQuorumTip(height);
  const lines = (await readFile(join(networkDir, `data-${validator}`, "blocks.ndjson"), "utf8")).split("\n").filter(Boolean).slice(0, height);
  if (lines.length !== height) throw new Error(`this validator's log has no block at height ${height}`);
  const workDir = await mkdtemp(join(tmpdir(), "zyron-t1-summary-"));
  try {
    return await anchor.summaryFromLog({
      genesis, genesisHash: new ZyronChain(genesis).genesisHash, lines, workDir, quorumTip,
      provenance: { publisher: need(o, "publisher"), workflow: need(o, "workflow"), commit: need(o, "commit") }, sealedAtMs: Date.now()
    });
  } finally { await rm(workDir, { recursive: true, force: true }); }
}

export async function assembleSeal(o) {
  const trust = await anchor.loadRestoreTrust(resolve(o["trust-dir"] ?? anchor.DEFAULT_RESTORE_TRUST_DIR));
  const summary = await readJson(need(o, "summary"));
  const raw = api.restoreSealText(need(o, "key-id"), need(o, "signature"), summary);
  await api.verifyRestoreSeal(raw, { pinnedKeys: trust.pinnedKeys });
  return raw;
}

export async function appendHighWater(o) {
  const trustDir = resolve(o["trust-dir"] ?? anchor.DEFAULT_RESTORE_TRUST_DIR);
  const summary = await readJson(need(o, "summary"));
  api.assertSummarySchema(summary);
  const file = api.parseHighWaterFile(await readJson(join(trustDir, anchor.RESTORE_TRUST_FILES.highWater)));
  return api.appendHighWaterEntry(file, { chainId: summary.chainId, height: summary.height, tipHash: summary.tipHash, summaryDigest: api.restoreSummaryDigest(need(o, "key-id"), summary), reason: need(o, "reason") });
}

const invokedDirectly = (() => { try { return resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url); } catch { return false; } })();
if (invokedDirectly) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    const o = options(rest);
    if (command === "build") process.stdout.write(`${canonicalJson(await buildFromLiveQuorum(o))}\n`);
    else if (command === "assemble") process.stdout.write(await assembleSeal(o));
    else if (command === "high-water") process.stdout.write(`${JSON.stringify(await appendHighWater(o), null, 2)}\n`);
    else throw new Error("usage: t1-build-summary.mjs build|assemble|high-water ...");
  } catch (error) {
    process.stderr.write(`t1-build-summary: ${error?.code ? `[${error.code}] ` : ""}${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
