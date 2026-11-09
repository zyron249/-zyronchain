// S2-3 T1 fixture anchor for restore tests that are about something else
// (progress, retries, durability). The restore now requires an independently
// sealed summary; these helpers build one from the source network's own
// validator logs (never from the bundle) and sign it with an Ed25519 TEST key
// generated at runtime and never written outside the test's temp directory.
// No real or pinned key is involved.
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const l1Root = fileURLToPath(new URL("../../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anchorApi: any = await import(pathToFileURL(join(l1Root, "dist", "src", "sealed-summary.js")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bootAnchor: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet", "restore-anchor.mjs")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { canonicalJson }: any = await import(pathToFileURL(join(l1Root, "dist", "src", "codec.js")).href);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const VALIDATORS = ["v1", "v2", "v3", "v4"];

export interface FixtureSource { genesis: Json; genesisHash: string; logPaths: string[]; height: number }

/** The four validator logs of a network directory, at `height` (default: the full v1 log). */
export async function fixtureSourceOf(networkDir: string, height?: number): Promise<FixtureSource> {
  const genesis = JSON.parse(await readFile(join(networkDir, "genesis.json"), "utf8"));
  const network = JSON.parse(await readFile(join(networkDir, "network.json"), "utf8"));
  const logPaths = VALIDATORS.map((name) => join(networkDir, `data-${name}`, "blocks.ndjson"));
  const h = height ?? (await readFile(logPaths[0]!, "utf8")).split("\n").filter(Boolean).length;
  return { genesis, genesisHash: network.genesisHash, logPaths, height: h };
}

async function fixtureSeal(source: FixtureSource, workDir: string): Promise<{ seal: Json; quorumTip: Json; keyId: string; publicKey: string }> {
  const { summary, quorumTip } = await bootAnchor.summaryFromValidatorLogs({
    ...source, workDir,
    provenance: { publisher: "TEST-FIXTURE-ONLY", workflow: "l1/test/helpers/restore-anchor-fixture.ts", commit: "0".repeat(40) }
  });
  const key = generateKeyPairSync("ed25519");
  const publicKey = anchorApi.ed25519RawPublicKeyHex(key.publicKey);
  const keyId = anchorApi.restoreKeyId(publicKey);
  return { seal: { summary, keyId, signature: anchorApi.signRestoreSummary(keyId, summary, key.privateKey) }, quorumTip, keyId, publicKey };
}

/** An in-process restoreAnchor around a fresh TEST key. */
export async function fixtureRestoreAnchor(source: FixtureSource, workDir: string): Promise<Json> {
  const { seal, quorumTip, keyId, publicKey } = await fixtureSeal(source, workDir);
  return {
    pinnedKeys: [{ keyId, publicKey }],
    readSeal: async () => structuredClone(seal),
    readSuperseded: async () => [],
    readHighWater: async () => null,
    readQuorumTip: async (height: number) => {
      if (height !== quorumTip.height) throw new Error(`TEST STUB: no live quorum tip at height ${height}`);
      return { ...quorumTip };
    }
  };
}

/**
 * For CLI restore tests: a fixture trust directory (pinned TEST key, empty
 * records, config) plus local fake validators serving GET /v{n}/block/{h}
 * from the source validators' own logs, and a node --import preload that
 * points the boot at that directory. Spawn with `[...nodeArgs, script, ...]`.
 */
export async function startFixtureTrustDir(root: string, source: FixtureSource): Promise<{ nodeArgs: string[]; trustDir: string; close: () => Promise<void> }> {
  const trustDir = join(root, "t1-trust");
  await mkdir(trustDir, { recursive: true });
  const { seal, keyId, publicKey } = await fixtureSeal(source, join(root, "t1-summary-replay"));
  const logs = await Promise.all(source.logPaths.map(async (path) => (await readFile(path, "utf8")).split("\n").filter(Boolean)));
  const server: Server = createServer((request, response) => {
    const match = /^\/v(\d)\/block\/(\d+)$/.exec(request.url ?? "");
    const line = match ? logs[Number(match[1]) - 1]?.[Number(match[2]) - 1] : undefined;
    if (!line) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(line);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const sealPath = join(root, "t1-seal.json");
  await writeFile(sealPath, canonicalJson(seal));
  const write = (name: string, value: Json) => writeFile(join(trustDir, name), `${JSON.stringify(value, null, 2)}\n`);
  await write("t1-summary-keys.json", { format: anchorApi.RESTORE_KEYS_FORMAT, networkClass: "testnet", purpose: anchorApi.RESTORE_KEY_PURPOSE, keys: [{ keyId, publicKey, addedIn: "TEST-FIXTURE-ONLY" }] });
  await write("t1-summary-record.json", { format: anchorApi.RESTORE_RECORD_FORMAT, entries: [] });
  await write("t1-high-water.json", { format: anchorApi.RESTORE_HIGH_WATER_FORMAT, entries: [] });
  await write("restore-anchor-config.json", {
    format: anchorApi.RESTORE_CONFIG_FORMAT, chainId: source.genesis.chainId, sealUrl: pathToFileURL(sealPath).href,
    quorum: { threshold: 3, timeoutMs: 30_000, validators: source.genesis.validators.map((validator: Json, index: number) => ({ publicKey: validator.publicKey, url: `http://127.0.0.1:${port}/v${index + 1}` })) }
  });
  const preload = join(root, "t1-trust-preload.mjs");
  await writeFile(preload, `globalThis[Symbol.for("zyronchain.open-testnet.test-restore-trust-dir")] = ${JSON.stringify(trustDir)};\n`);
  return { nodeArgs: ["--import", pathToFileURL(preload).href], trustDir, close: async () => { server.close(); } };
}

let replays = 0;
/** fixtureRestoreAnchor for a network directory (its four validator logs), replaying beside it. */
export async function anchorForNetworkDir(networkDir: string, height?: number): Promise<Json> {
  replays += 1;
  return fixtureRestoreAnchor(await fixtureSourceOf(networkDir, height), `${networkDir}.t1-replay-${process.pid}-${replays}`);
}
