#!/usr/bin/env node
// S2-3 trust anchor T1 signer (docs/specs/s2-3-t1-sealed-summary.md).
//
//   node l1/scripts/t1-sign-summary.mjs --summary <summary.json> --key-file <path>
//
// Signs one open-testnet restore summary with the single-purpose, testnet-only
// Ed25519 restore-summary key and prints ONLY {"keyId","signature"} on stdout.
// The private key is read only from --key-file: an absolute path to a regular
// file (not a symlink) owned by this user with mode 0600, outside /workspace
// and outside this repository. Key material on the command line or in the
// environment is refused. The key, its path contents and its PEM are never
// printed or logged; errors are generic.
import { createPrivateKey } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repoRoot = dirname(l1Root);
const FORBIDDEN_ROOTS = ["/workspace", repoRoot];
const KEY_MATERIAL = /PRIVATE KEY|^[0-9a-fA-F]{64,}$|^[A-Za-z0-9+/=_-]{43,}$/;

export class SignerRefusal extends Error {}
const refuse = (message) => { throw new SignerRefusal(message); };

function within(path, root) {
  const r = resolve(root);
  return path === r || path.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** Parses argv strictly: only --summary and --key-file, each once, never key material. */
export function parseSignerArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag !== "--summary" && flag !== "--key-file") refuse("unknown argument (only --summary <file> and --key-file <path> are accepted; key material is never accepted on the command line)");
    const value = argv[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) refuse(`${flag} needs a value`);
    if (KEY_MATERIAL.test(value)) refuse("key material is never accepted on the command line; pass --key-file <path>");
    if (options[flag]) refuse(`${flag} given twice`);
    options[flag] = value;
    i += 1;
  }
  if (!options["--summary"] || !options["--key-file"]) refuse("usage: t1-sign-summary.mjs --summary <summary.json> --key-file <path>");
  return { summaryPath: options["--summary"], keyFile: options["--key-file"] };
}

/** Refuses key material in the environment (any variable whose value holds a PEM private key). */
export function assertNoEnvKey(env) {
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && /PRIVATE KEY/.test(value)) refuse(`the environment variable ${name} holds key material; the key is read only from --key-file`);
    if (/^ZYRON.*(KEY|SEED|SECRET)/i.test(name) && /T1|RESTORE|SUMMARY|SEAL/i.test(name)) refuse(`the environment variable ${name} looks like a restore-summary key; the key is read only from --key-file`);
  }
}

/** Checks the key file location and permissions, then returns its contents. */
export function readKeyFile(keyFile, { uid = process.getuid?.(), forbiddenRoots = FORBIDDEN_ROOTS } = {}) {
  if (!isAbsolute(keyFile)) refuse("--key-file must be an absolute path");
  let info;
  try { info = lstatSync(keyFile); } catch { return refuse("the key file cannot be read"); }
  if (info.isSymbolicLink()) refuse("the key file must not be a symlink");
  if (!info.isFile()) refuse("the key file must be a regular file");
  if ((info.mode & 0o777) !== 0o600) refuse("the key file must have mode 0600");
  if (uid !== undefined && info.uid !== uid) refuse("the key file must be owned by this user");
  let real;
  try { real = realpathSync(keyFile); } catch { return refuse("the key file cannot be read"); }
  for (const root of forbiddenRoots) {
    let resolvedRoot = root;
    try { resolvedRoot = realpathSync(root); } catch { /* root absent */ }
    if (within(real, resolvedRoot) || within(resolve(keyFile), root)) refuse("the key file must be outside /workspace and outside the repository");
  }
  try { return readFileSync(real, "utf8"); } catch { return refuse("the key file cannot be read"); }
}

export async function signSummaryFile({ summaryPath, keyFile }, deps = {}) {
  const api = await import(join(l1Root, "dist/src/sealed-summary.js"));
  let summary;
  try { summary = JSON.parse(readFileSync(resolve(summaryPath), "utf8")); } catch { refuse("the summary file is not JSON"); }
  try { api.assertSummarySchema(summary); } catch { refuse("the summary does not match the v1 schema"); }
  if (!api.isTestnetChainId(summary.chainId)) refuse("this key signs open-testnet summaries only");
  const pem = readKeyFile(keyFile, deps);
  let privateKey;
  try { privateKey = createPrivateKey({ key: pem, format: "pem" }); } catch { refuse("the key file is not a PEM private key"); }
  if (privateKey.asymmetricKeyType !== "ed25519") refuse("the restore-summary key must be Ed25519");
  const keyId = api.restoreKeyId(api.ed25519RawPublicKeyHex(privateKey));
  const signature = api.signRestoreSummary(keyId, summary, privateKey);
  return { keyId, signature };
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  try {
    assertNoEnvKey(process.env);
    const result = await signSummaryFile(parseSignerArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    // Never echo key material: only our own refusal messages are printed.
    process.stderr.write(`t1-sign-summary: ${error instanceof SignerRefusal ? error.message : "signing failed"}\n`);
    process.exit(1);
  }
}
