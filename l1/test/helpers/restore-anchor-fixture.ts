// S2-3 T1 fixture anchor for restore tests that are about something else
// (progress, retries, durability). The restore now requires an independently
// sealed summary; these helpers build one from the source network's own
// validator logs (never from the bundle) and sign it with an Ed25519 TEST key
// generated at runtime and never written outside the test's temp directory.
// No real or pinned key is involved.
import { generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { cp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const l1Root = fileURLToPath(new URL("../../../", import.meta.url));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anchorApi: any = await import(pathToFileURL(join(l1Root, "dist", "src", "sealed-summary.js")).href);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bootAnchor: any = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet", "restore-anchor.mjs")).href);

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

async function fixtureSeal(source: FixtureSource, workDir: string): Promise<{ seal: string; summary: Json; summaryDigest: string; quorumTip: Json; keyId: string; publicKey: string }> {
  const { summary, quorumTip } = await bootAnchor.summaryFromValidatorLogs({
    ...source, workDir,
    provenance: { publisher: "TEST-FIXTURE-ONLY", workflow: "l1/test/helpers/restore-anchor-fixture.ts", commit: "0".repeat(40) }
  });
  const key = generateKeyPairSync("ed25519");
  const publicKey = anchorApi.ed25519RawPublicKeyHex(key.publicKey);
  const keyId = anchorApi.restoreKeyId(publicKey);
  const seal = anchorApi.restoreSealText(keyId, anchorApi.signRestoreSummary(keyId, summary, key.privateKey), summary);
  return { seal, summary, summaryDigest: anchorApi.restoreSummaryDigest(keyId, summary), quorumTip, keyId, publicKey };
}

/** An in-process restoreAnchor around a fresh TEST key. */
export async function fixtureRestoreAnchor(source: FixtureSource, workDir: string): Promise<Json> {
  const { seal, summary, summaryDigest, quorumTip, keyId, publicKey } = await fixtureSeal(source, workDir);
  return {
    pinnedKeys: [{ keyId, publicKey, revoked: false }],
    readSeal: async () => seal,
    readSuperseded: async () => [],
    readHighWater: async () => ({ height: summary.height, summaryDigest, tipHash: summary.tipHash }),
    timeoutMs: 30_000,
    readQuorumTip: async (height: number) => {
      if (height !== quorumTip.height) throw new Error(`TEST STUB: no live quorum tip at height ${height}`);
      return { ...quorumTip };
    }
  };
}

/**
 * For CLI restore tests: a temporary l1 tree (a copy of l1/scripts, with
 * dist, node_modules and package.json linked to the real ones) whose trust/
 * holds fixture files (pinned TEST key, seal, high-water entry, empty record,
 * config), plus local fake validators, one HTTP server (one URL origin) each,
 * serving GET /block/{h} from the source validators' own logs. The boot has
 * no runtime trust-dir override, so CLI tests spawn `script` from this tree.
 * The fixture trust dir carries the loopback-fixture marker so its
 * 127.0.0.1 quorum is accepted; the repository's l1/trust/ never does.
 */
export async function startFixtureTrustDir(root: string, source: FixtureSource): Promise<{ script: string; nodeArgs: string[]; trustDir: string; close: () => Promise<void> }> {
  const tree = join(root, "t1-l1");
  await cp(join(l1Root, "scripts"), join(tree, "scripts"), { recursive: true });
  for (const name of ["dist", "node_modules", "package.json"]) await symlink(join(l1Root, name), join(tree, name));
  const trustDir = join(tree, "trust");
  await mkdir(trustDir, { recursive: true });
  const { seal, summary, summaryDigest, keyId, publicKey } = await fixtureSeal(source, join(root, "t1-summary-replay"));
  const logs = await Promise.all(source.logPaths.map(async (path) => (await readFile(path, "utf8")).split("\n").filter(Boolean)));
  const servers: Server[] = [];
  const urls: string[] = [];
  for (const lines of logs) {
    const server: Server = createServer((request, response) => {
      const match = /^\/block\/(\d+)$/.exec(request.url ?? "");
      const line = match ? lines[Number(match[1]) - 1] : undefined;
      if (!line) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(line);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push(server);
    urls.push(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
  }
  await writeFile(join(trustDir, bootAnchor.RESTORE_TRUST_FILES.seal), seal);
  await writeFile(join(trustDir, bootAnchor.LOOPBACK_FIXTURE_MARKER), "TEST FIXTURE ONLY: loopback quorum sources are accepted in this directory.\n");
  const write = (name: string, value: Json) => writeFile(join(trustDir, name), `${JSON.stringify(value, null, 2)}\n`);
  await write("t1-summary-keys.json", { format: anchorApi.RESTORE_KEYS_FORMAT, networkClass: "testnet", purpose: anchorApi.RESTORE_KEY_PURPOSE, keys: [{ keyId, publicKey, addedIn: "TEST-FIXTURE-ONLY" }] });
  await write("t1-summary-record.json", { format: anchorApi.RESTORE_RECORD_FORMAT, entries: [] });
  await write("t1-high-water.json", anchorApi.appendHighWaterEntry({ format: anchorApi.RESTORE_HIGH_WATER_FORMAT, entries: [] }, { chainId: source.genesis.chainId, height: summary.height, tipHash: summary.tipHash, summaryDigest, reason: "TEST-FIXTURE-ONLY seal" }));
  await write("restore-anchor-config.json", {
    format: anchorApi.RESTORE_CONFIG_FORMAT, chainId: source.genesis.chainId,
    quorum: { threshold: 3, timeoutMs: 30_000, validators: source.genesis.validators.map((validator: Json, index: number) => ({ publicKey: validator.publicKey, url: urls[index] })) }
  });
  return {
    script: join(tree, "scripts", "open-testnet.mjs"), nodeArgs: [], trustDir,
    close: async () => { for (const server of servers) { server.closeAllConnections(); server.close(); } }
  };
}

let replays = 0;
/** fixtureRestoreAnchor for a network directory (its four validator logs), replaying beside it. */
export async function anchorForNetworkDir(networkDir: string, height?: number): Promise<Json> {
  replays += 1;
  return fixtureRestoreAnchor(await fixtureSourceOf(networkDir, height), `${networkDir}.t1-replay-${process.pid}-${replays}`);
}
