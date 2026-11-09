// S2-3 trust anchor T1 implementation tests (docs/specs/s2-3-t1-sealed-summary.md):
// the shipped placeholder trust files, the boot path (anchor only from the
// pinned repository files; refuse and exit, never a fresh genesis), the real
// live-quorum tip reader (threshold of distinct trusted validators, each
// secp256k1-verified; disagreement / timeout fail closed), the append-only
// records and high-water resolution, the smoke fixture anchor, and the signer
// CLI. Every key here is a TEST key generated at runtime; no key is pinned.
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBlockAttestation, createSignedBlock } from "../src/block.js";
import { canonicalJson } from "../src/codec.js";
import { generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
import * as anchorApi from "../src/sealed-summary.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const l1Root = fileURLToPath(new URL("../../", import.meta.url));
const repoRoot = join(l1Root, "..");
const script = join(l1Root, "scripts", "open-testnet.mjs");
const boot: Json = await import(pathToFileURL(join(l1Root, "scripts", "open-testnet", "restore-anchor.mjs")).href);
const net: Json = await import(pathToFileURL(script).href);
const signer: Json = await import(pathToFileURL(join(l1Root, "scripts", "t1-sign-summary.mjs")).href);
const C = anchorApi.RESTORE_ANCHOR_CODES;
const CHAIN_ID = "zyron-open-testnet-1";

const codeOf = async (run: () => unknown): Promise<string | undefined> => {
  try { await run(); } catch (error: Json) {
    assert.equal(error?.cause, undefined, "a refusal carries no cause");
    assert.equal(net.isLocalIoError(error), false, "a refusal is never a local I/O error");
    return error?.code;
  }
  return undefined;
};

test("T1 placeholder: the repository pins no key, no seal and no quorum; the boot anchor is refused as missing", async () => {
  const dir = join(l1Root, "trust");
  const keys = JSON.parse(await readFile(join(dir, "t1-summary-keys.json"), "utf8"));
  assert.deepEqual(keys.keys, [], "no restore summary key may be pinned by this change");
  assert.deepEqual(JSON.parse(await readFile(join(dir, "t1-summary-record.json"), "utf8")).entries, []);
  assert.deepEqual(JSON.parse(await readFile(join(dir, "t1-high-water.json"), "utf8")).entries, []);
  const config = JSON.parse(await readFile(join(dir, "restore-anchor-config.json"), "utf8"));
  assert.deepEqual(config, { format: anchorApi.RESTORE_CONFIG_FORMAT, chainId: null, quorum: { threshold: 0, timeoutMs: 30000, validators: [] } });
  assert.equal(existsSync(join(dir, "t1-sealed-summary.txt")), false, "no seal is published by this change");
  for (const name of readdirSync(dir)) assert.doesNotMatch(await readFile(join(dir, name), "utf8"), /PRIVATE KEY/);
  assert.equal(boot.bootRestoreTrustDir(), dir, "the boot reads the repository trust directory");
  assert.equal(await codeOf(() => boot.createRestoreAnchor({ chainId: CHAIN_ID })), C.anchorMissing);
});

test("T1 boot config: broken or incomplete pinned files refuse with RESTORE_ANCHOR_CONFIG_INVALID", async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-t1-config-"));
  try {
    const key = generateKeyPairSync("ed25519");
    const publicKey = anchorApi.ed25519RawPublicKeyHex(key.publicKey);
    const keyId = anchorApi.restoreKeyId(publicKey);
    const write = (name: string, value: Json) => writeFile(join(root, name), JSON.stringify(value));
    await write("t1-summary-keys.json", { format: anchorApi.RESTORE_KEYS_FORMAT, networkClass: "testnet", purpose: anchorApi.RESTORE_KEY_PURPOSE, keys: [{ keyId, publicKey, addedIn: "TEST" }] });
    await write("t1-summary-record.json", { format: anchorApi.RESTORE_RECORD_FORMAT, entries: [] });
    await write("t1-high-water.json", { format: anchorApi.RESTORE_HIGH_WATER_FORMAT, entries: [] });
    await write("restore-anchor-config.json", { format: anchorApi.RESTORE_CONFIG_FORMAT, chainId: null, quorum: { threshold: 0, timeoutMs: 1000, validators: [] } });
    assert.equal(await codeOf(() => boot.createRestoreAnchor({ chainId: CHAIN_ID, trustDir: root })), C.anchorConfigInvalid, "key pinned, no chain / quorum");
    await write("t1-summary-keys.json", { format: anchorApi.RESTORE_KEYS_FORMAT, networkClass: "testnet", purpose: anchorApi.RESTORE_KEY_PURPOSE, keys: [{ keyId: "t1-wrong", publicKey, addedIn: "TEST" }] });
    assert.equal(await codeOf(() => boot.createRestoreAnchor({ chainId: CHAIN_ID, trustDir: root })), C.anchorConfigInvalid, "keyId not derived from the key");
    await write("restore-anchor-config.json", { format: anchorApi.RESTORE_CONFIG_FORMAT, chainId: CHAIN_ID, sealUrl: "https://example.invalid/seal", quorum: { threshold: 0, timeoutMs: 1000, validators: [] } });
    assert.equal(await codeOf(() => boot.loadRestoreTrust(root)), C.anchorConfigInvalid, "a seal URL (non-repository source) is not accepted");
    await rm(join(root, "t1-high-water.json"));
    assert.equal(await codeOf(() => boot.loadRestoreTrust(root)), C.anchorConfigInvalid, "missing high-water file");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("T1 boot CLI: with the placeholder trust files a published snapshot is refused before decryption, start-up exits and no fresh genesis is created", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zyron-t1-boot-"));
  const server: Server = createServer((_request, response) => { response.writeHead(200); response.end(Buffer.alloc(64, 7)); });
  try {
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const target = join(root, "hosted");
    const child = spawn(process.execPath, [script, "run", "--dir", target, "--host", "127.0.0.1", "--port", "0", "--init-if-missing", "--restore-url", `http://127.0.0.1:${port}/snapshot`], {
      cwd: l1Root, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ZYRON_TESTNET_STATE_SECRET: "x".repeat(40), ZYRON_TESTNET_ALLOW_FRESH_GENESIS: "1", PORT: "" }
    });
    let log = "";
    child.stdout!.on("data", (c) => { log += c; }); child.stderr!.on("data", (c) => { log += c; });
    let timer: NodeJS.Timeout | undefined;
    const [exitCode] = await Promise.race([once(child, "exit"), new Promise<never>((_, reject) => { timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`boot did not exit: ${log}`)); }, 90_000); })]).finally(() => clearTimeout(timer));
    assert.equal(exitCode, 1, log);
    assert.match(log, /STATE RESTORE FAILED \(restore refused \[RESTORE_ANCHOR_MISSING\]/);
    assert.match(log, /refusing to create a fresh TEST genesis/);
    assert.doesNotMatch(log, /creating a fresh TEST genesis|"genesisHash"/);
    assert.equal(existsSync(join(target, "network.json")), false);
    assert.equal(existsSync(join(target, "genesis.json")), false);
  } finally { server.close(); await rm(root, { recursive: true, force: true }); }
});

// ---- live quorum tip reader ----------------------------------------------------

function quorumFixture(count = 4) {
  const privateKeys = Array.from({ length: count }, () => generatePrivateKey());
  const publicKeys = privateKeys.map((key) => publicKeyFromPrivate(key));
  const makeBlock = (height: number, tag: string, attesters: number[], signers = privateKeys) => {
    const block = createSignedBlock({
      version: 6, chainId: CHAIN_ID, height, round: 0, previousHash: tag.repeat(64).slice(0, 64), timestampMs: 1_700_000_000_000 + height,
      transactions: [], stateRoot: "ab".repeat(32), proposerPrivateKey: privateKeys[0]!, proposerPublicKey: publicKeys[0]!
    });
    return { ...block, attestations: attesters.map((index) => createBlockAttestation(block, signers[index]!, publicKeys[index]!)) };
  };
  return { privateKeys, publicKeys, makeBlock };
}
async function serveBlocks(byValidator: Array<(height: number) => Json | "hang" | undefined>): Promise<{ urls: string[]; close: () => void }> {
  const server: Server = createServer((request, response) => {
    const match = /^\/v(\d+)\/block\/(\d+)$/.exec(request.url ?? "");
    const answer = match ? byValidator[Number(match[1])]?.(Number(match[2])) : undefined;
    if (answer === "hang") return;
    if (!answer) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(answer));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { urls: byValidator.map((_, index) => `http://127.0.0.1:${port}/v${index}`), close: () => { server.closeAllConnections(); server.close(); } };
}

test("T1 quorum tip: a threshold of distinct trusted validators, each secp256k1-verified, gives the tip; too few, forged, disagreement and timeout fail closed with their own codes", { timeout: 60_000 }, async () => {
  const { publicKeys, makeBlock } = quorumFixture();
  const honest = makeBlock(10, "1", [0, 1, 2, 3]);
  const reader = async (answers: Array<(height: number) => Json>, timeoutMs = 2_000) => {
    const served = await serveBlocks(answers);
    try {
      const read = boot.quorumTipReader({ chainId: CHAIN_ID, threshold: 3, timeoutMs, validators: publicKeys.map((publicKey, index) => ({ publicKey, url: served.urls[index] })) });
      return await read(10);
    } finally { served.close(); }
  };
  assert.deepEqual(await reader(publicKeys.map(() => () => honest)), { height: 10, tipHash: honest.hash });
  // One source with all four attestations is not enough: at least two sources.
  assert.equal(await codeOf(() => reader([() => honest, () => undefined, () => undefined, () => undefined])), C.quorumTipUnavailable, "one source");
  // Only two trusted attesters (below threshold 3).
  const thin = makeBlock(10, "1", [0, 1]);
  assert.equal(await codeOf(() => reader(publicKeys.map(() => () => thin))), C.quorumTipUnavailable, "below threshold");
  // Attestations signed by untrusted keys under the trusted public keys do not verify.
  const forgedSigners = publicKeys.map(() => generatePrivateKey());
  const forged = makeBlock(10, "1", [0, 1, 2, 3], forgedSigners);
  assert.equal(await codeOf(() => reader(publicKeys.map(() => () => forged))), C.quorumTipUnavailable, "forged attestations");
  // A tampered header (hash no longer matches) is not counted.
  const tampered = { ...honest, header: { ...honest.header, stateRoot: "cd".repeat(32) } };
  assert.equal(await codeOf(() => reader(publicKeys.map(() => () => tampered))), C.quorumTipUnavailable, "tampered header");
  // Two verified, different tips at the same height.
  const fork = makeBlock(10, "2", [0, 1, 2, 3]);
  assert.equal(await codeOf(() => reader([() => honest, () => honest, () => fork, () => fork])), C.quorumTipMismatch, "disagreement");
  // Sources that hang: the deadline fires.
  assert.equal(await codeOf(() => reader([() => honest, () => "hang", () => "hang", () => "hang"], 300)), C.quorumTipTimeout, "timeout");
});

// ---- records and high-water --------------------------------------------------

const digest = (n: number) => n.toString(16).padStart(64, "0");
test("T1 high-water: append-only log; the effective value is the highest entry not superseded (superseding H+50 resolves to H)", () => {
  const H = 1_000;
  let file: Json = { format: anchorApi.RESTORE_HIGH_WATER_FORMAT, entries: [] };
  file = anchorApi.appendHighWaterEntry(file, { chainId: CHAIN_ID, height: H, summaryDigest: digest(1), reason: "seal at H" });
  file = anchorApi.appendHighWaterEntry(file, { chainId: CHAIN_ID, height: H + 50, summaryDigest: digest(2), reason: "seal at H+50" });
  assert.deepEqual(anchorApi.highWaterFor(file, CHAIN_ID), { height: H + 50, summaryDigest: digest(2) });
  const superseded = [{ summaryDigest: digest(2), height: H + 50, tipHash: digest(9) }];
  assert.deepEqual(anchorApi.highWaterFor(file, CHAIN_ID, superseded), { height: H, summaryDigest: digest(1) }, "superseding H+50 resolves to H");
  assert.equal(anchorApi.highWaterFor(file, "zyron-open-testnet-2"), null);
  // Append-only: edits, removals and duplicates are refused.
  const edited = structuredClone(file); edited.entries[0].height = H - 1;
  assert.throws(() => anchorApi.parseHighWaterFile(edited), (error: Json) => error.code === C.anchorConfigInvalid);
  const removed = structuredClone(file); removed.entries.shift();
  assert.throws(() => anchorApi.parseHighWaterFile(removed), (error: Json) => error.code === C.anchorConfigInvalid);
  assert.throws(() => anchorApi.appendHighWaterEntry(file, { chainId: CHAIN_ID, height: H + 60, summaryDigest: digest(1), reason: "again" }), (error: Json) => error.code === C.anchorConfigInvalid);
});

test("T1 record: revoke-key, supersede-key and supersede-summary entries are append-only and apply to the pinned keys", () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = anchorApi.ed25519RawPublicKeyHex(key.publicKey);
  const keyId = anchorApi.restoreKeyId(publicKey);
  const keys = { format: anchorApi.RESTORE_KEYS_FORMAT, networkClass: "testnet", purpose: anchorApi.RESTORE_KEY_PURPOSE, keys: [{ keyId, publicKey, addedIn: "TEST" }] };
  let record: Json = { format: anchorApi.RESTORE_RECORD_FORMAT, entries: [] };
  assert.deepEqual(anchorApi.restoreTrustFromFiles(keys, record), { pinnedKeys: [{ keyId, publicKey, revoked: false }], superseded: [] });
  record = anchorApi.appendRecordEntry(record, { kind: "supersede-key", keyId, supersededAtHeight: 500, reason: "rotation" });
  record = anchorApi.appendRecordEntry(record, { kind: "supersede-summary", summaryDigest: digest(3), height: 400, tipHash: digest(4), reason: "replaced" });
  assert.deepEqual(anchorApi.restoreTrustFromFiles(keys, record), { pinnedKeys: [{ keyId, publicKey, revoked: false, supersededAtHeight: 500 }], superseded: [{ summaryDigest: digest(3), height: 400, tipHash: digest(4) }] });
  record = anchorApi.appendRecordEntry(record, { kind: "revoke-key", keyId, reason: "compromise" });
  assert.equal(anchorApi.restoreTrustFromFiles(keys, record).pinnedKeys[0]!.revoked, true);
  const edited = structuredClone(record); edited.entries[1].height = 401;
  assert.throws(() => anchorApi.parseRecordFile(edited), (error: Json) => error.code === C.anchorConfigInvalid);
});

test("T1 seal parsing: Infinity, -0 and unsafe integers are schema errors, NaN/+1/01 are malformed, and nothing escapes uncoded", async () => {
  const key = generateKeyPairSync("ed25519");
  const publicKey = anchorApi.ed25519RawPublicKeyHex(key.publicKey);
  const keyId = anchorApi.restoreKeyId(publicKey);
  const summary: Json = { format: anchorApi.RESTORE_SUMMARY_FORMAT, chainId: CHAIN_ID, genesisHash: digest(1), height: 7, tipHash: digest(2), stateRoot: digest(3), totalSupplyAtoms: "5", burnedAtoms: "0", validatorSetHash: digest(4), oracleSetHash: digest(5), provenance: { commit: "0".repeat(40), publisher: "TEST", workflow: "TEST" }, sealedAtMs: 1 };
  const raw = anchorApi.restoreSealText(keyId, anchorApi.signRestoreSummary(keyId, summary, key.privateKey), summary);
  const pinnedKeys = [{ keyId, publicKey, revoked: false }];
  assert.equal((await anchorApi.verifyRestoreSeal(raw, { pinnedKeys })).keyId, keyId);
  const swap = (value: string) => raw.replace('"height":7', `"height":${value}`);
  for (const value of ["1e999", "-0", "9007199254740993", "7.0", "7e0"]) assert.equal(await codeOf(() => anchorApi.verifyRestoreSeal(swap(value), { pinnedKeys })), C.sealSchemaInvalid, value);
  for (const value of ["NaN", "+7", "07", "Infinity"]) assert.equal(await codeOf(() => anchorApi.verifyRestoreSeal(swap(value), { pinnedKeys })), C.sealMalformed, value);
  // Order: a malformed seal is reported before a broken key config.
  assert.equal(await codeOf(() => anchorApi.verifyRestoreSeal("{", { pinnedKeys: [] })), C.sealMalformed);
  assert.equal(await codeOf(() => anchorApi.verifyRestoreSeal(raw, { pinnedKeys: [] })), C.anchorConfigInvalid);
  assert.equal(await codeOf(() => anchorApi.verifyRestoreSeal(raw, undefined as Json)), C.anchorConfigInvalid);
  // Strict hex: an uppercase public key is a config error, never decoded.
  assert.equal(await codeOf(() => anchorApi.verifyRestoreSeal(raw, { pinnedKeys: [{ keyId, publicKey: publicKey.toUpperCase(), revoked: false }] })), C.anchorConfigInvalid);
});

test("T1 smoke: the smoke restore uses a runtime fixture anchor (sealed text, high-water, quorum tip) and asserts the unanchored restore is refused", async () => {
  const source = await readFile(script, "utf8");
  const smoke = source.slice(source.indexOf("async function smoke("));
  assert.ok(smoke.length > 0);
  assert.match(smoke, /generateKeyPairSync\("ed25519"\)/);
  assert.match(smoke, /summaryFromValidatorLogs\(/);
  assert.match(smoke, /restoreSealText\(/);
  assert.match(smoke, /readHighWater: async \(\) => \(\{ height: smokeSummary\.height, summaryDigest: smokeDigest \}\)/);
  assert.match(smoke, /restoreNetwork\(join\(dir, "refused"\)[^;]*anchorMissing/);
  assert.match(smoke, /restoreNetwork\(join\(dir, "restored"\)[^;]*\{ restoreAnchor: smokeAnchor \}/);
});

test("T1 restore output is staged beside the target and renamed into place only on success", () => {
  assert.equal(net.restoreStagingDir("/srv/net"), "/srv/net.restore-staging");
});

// ---- signer CLI ------------------------------------------------------------------

test("T1 signer CLI: key only from a 0600 file outside /workspace and the repository; argv/env keys refused; prints only keyId and signature", { timeout: 60_000 }, async () => {
  const outside = await mkdtemp(join(homedir() && existsSync(homedir()) ? homedir() : tmpdir(), ".zyron-t1-signer-test-"));
  try {
    const key = generateKeyPairSync("ed25519");
    const pem = key.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const keyFile = join(outside, "TEST-FIXTURE-ONLY.pem");
    await writeFile(keyFile, pem, { mode: 0o600 });
    const summary: Json = { format: anchorApi.RESTORE_SUMMARY_FORMAT, chainId: CHAIN_ID, genesisHash: digest(1), height: 7, tipHash: digest(2), stateRoot: digest(3), totalSupplyAtoms: "5", burnedAtoms: "0", validatorSetHash: digest(4), oracleSetHash: digest(5), provenance: { commit: "0".repeat(40), publisher: "TEST", workflow: "TEST" }, sealedAtMs: 1 };
    const summaryPath = join(outside, "summary.json");
    await writeFile(summaryPath, canonicalJson(summary));
    const run = async (args: string[], env: Json = {}) => {
      const child = spawn(process.execPath, [join(l1Root, "scripts", "t1-sign-summary.mjs"), ...args], { cwd: l1Root, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, ...env } });
      let out = ""; let err = "";
      child.stdout!.on("data", (c) => { out += c; }); child.stderr!.on("data", (c) => { err += c; });
      const [code] = await once(child, "exit");
      return { code, out, err };
    };
    const ok = await run(["--summary", summaryPath, "--key-file", keyFile]);
    assert.equal(ok.code, 0, ok.err);
    const printed = JSON.parse(ok.out);
    assert.deepEqual(Object.keys(printed).sort(), ["keyId", "signature"]);
    const publicKey = anchorApi.ed25519RawPublicKeyHex(key.publicKey);
    assert.equal(printed.keyId, anchorApi.restoreKeyId(publicKey));
    const raw = anchorApi.restoreSealText(printed.keyId, printed.signature, summary);
    assert.equal((await anchorApi.verifyRestoreSeal(raw, { pinnedKeys: [{ keyId: printed.keyId, publicKey, revoked: false }] })).keyId, printed.keyId);
    const keyBody = pem.split("\n")[1]!;
    for (const result of [ok]) assert.ok(!result.out.includes(keyBody) && !result.err.includes(keyBody));

    const refused = async (label: string, args: string[], env: Json = {}) => {
      const result = await run(args, env);
      assert.equal(result.code, 1, `${label}: ${result.out}`);
      assert.equal(result.out, "", `${label}: nothing on stdout`);
      assert.ok(!result.err.includes(keyBody), `${label}: key material echoed`);
    };
    await refused("key on argv", ["--summary", summaryPath, "--key", pem]);
    await refused("hex seed on argv", ["--summary", summaryPath, "--key-file", "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"]);
    await refused("key in env", ["--summary", summaryPath, "--key-file", keyFile], { SOME_VAR: pem });
    await refused("relative path", ["--summary", summaryPath, "--key-file", "TEST-FIXTURE-ONLY.pem"]);
    await chmod(keyFile, 0o640);
    await refused("group-readable key file", ["--summary", summaryPath, "--key-file", keyFile]);
    await chmod(keyFile, 0o600);
    const link = join(outside, "link.pem");
    await symlink(keyFile, link);
    await refused("symlink", ["--summary", summaryPath, "--key-file", link]);
    // Inside the repository / /workspace: refused (checked in-process to keep
    // the TEST key out of those trees on disk).
    assert.throws(() => signer.readKeyFile(join(repoRoot, "nonexistent.pem"), { forbiddenRoots: [repoRoot] }), signer.SignerRefusal);
    const fakeRoot = join(outside, "workspace-like");
    await mkdir(fakeRoot);
    const inside = join(fakeRoot, "k.pem");
    await writeFile(inside, pem, { mode: 0o600 });
    assert.throws(() => signer.readKeyFile(inside, { forbiddenRoots: [fakeRoot] }), /outside \/workspace and outside the repository/);
    assert.throws(() => signer.parseSignerArgs(["--summary", summaryPath, "--key-file", keyFile, "--key-file", keyFile]), signer.SignerRefusal);
    assert.throws(() => signer.assertNoEnvKey({ ZYRON_T1_RESTORE_KEY: "x" }), signer.SignerRefusal);
  } finally { await rm(outside, { recursive: true, force: true }); }
});
