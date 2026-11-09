#!/usr/bin/env node
// S2-3 T1: l1/trust/ is append-only (docs/specs/s2-3-t1-sealed-summary.md).
//
//   node l1/scripts/t1-trust-append-only.mjs --base <git ref>         [--head <git ref>]
//   node l1/scripts/t1-trust-append-only.mjs --merge-base <git ref>   [--head <git ref>]
//   node l1/scripts/t1-trust-append-only.mjs --push-before <sha>      [--head <git ref>]
//
// Run from inside the repository (the current directory selects it).
// Compares the trust files at a base commit with the head (read with
// `git show <ref>:l1/trust/<file>`, as data only) and fails unless:
//   - every trust JSON file at head is byte-canonical (exactly
//     JSON.stringify(value, null, 2) plus one trailing newline) with no
//     duplicate object keys;
//   - t1-summary-record.json and t1-high-water.json at head have a valid
//     index / prev hash chain and the base entries are an unchanged prefix of
//     the head entries (byte-identical canonical JSON, same positions), so no
//     entry is edited, removed, reordered or re-chained;
//   - every pinned key at base is still pinned, unchanged, at the same position
//     at head (keys are only ADDED; revocation and rotation go through the
//     record, never through edits), and every keyId is derived from its key;
//   - none of these files is deleted, and the loopback test-fixture marker is
//     never present.
// The seal text and the quorum config may change (a new seal replaces the old
// one together with its appended high-water entry).
//
// Base selection:
//   --base <ref>         that commit.
//   --merge-base <ref>   `git merge-base <ref> <head>` (CI: origin/main), so a
//                        stacked PR retargeted to main is compared with main,
//                        never with a stale base SHA.
//   --push-before <sha>  a push: the commit before the push. An all-zero SHA
//                        (branch created) falls back to the head's first
//                        parent, or to an empty base for a root commit; an
//                        unknown SHA fails closed.
//
// This script is SELF-CONTAINED (Node built-ins only, no l1/dist import), so
// CI can run the trusted copy taken from main (`git show <base>:...`) without
// building or executing any code of the change under review. The full entry
// schema is enforced again by the boot loader (l1/src/sealed-summary.ts).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const TRUST_PATH = "l1/trust";
export const APPEND_ONLY_FILES = Object.freeze({ keys: "t1-summary-keys.json", record: "t1-summary-record.json", highWater: "t1-high-water.json" });
export const CANONICAL_FILES = Object.freeze([...Object.values(APPEND_ONLY_FILES), "restore-anchor-config.json"]);
export const FORBIDDEN_FILES = Object.freeze(["TEST-FIXTURE-ONLY-loopback-quorum"]);
const FORMATS = Object.freeze({
  keys: "zyronchain-restore-summary-keys-v1",
  record: "zyronchain-restore-summary-record-v1",
  highWater: "zyronchain-restore-summary-high-water-v1"
});
const KEY_ID_DOMAIN = "zyronchain/open-testnet/restore-summary-key-id/v1";
const ZERO_HASH = "0".repeat(64);
const ZERO_SHA = /^(0{40}|0{64})$/;
const REF = /^[0-9A-Za-z._/~^-]{1,200}$/;

export class TrustAppendOnlyError extends Error {}
const fail = (message) => { throw new TrustAppendOnlyError(message); };

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hasExactly = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

/** RFC 8785 (JCS) canonical JSON for plain JSON values (same bytes as l1/src/codec.ts canonicalJson). */
export function jcs(value) {
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${jcs(value[key])}`).join(",")}}`;
  if (typeof value === "number" && !Number.isFinite(value)) fail("non-finite number");
  return JSON.stringify(value);
}
const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

/** First duplicated object key of a valid JSON text, or undefined. */
export function findDuplicateJsonKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack.at(-1);
      if (top && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) return key;
        top.keys.add(key);
        top.expectKey = false;
      }
      i = j;
    } else if (c === "{") stack.push({ keys: new Set(), expectKey: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === ",") { const top = stack.at(-1); if (top) top.expectKey = true; }
  }
  return undefined;
}

/** Parses one trust JSON file: valid JSON, no duplicate keys, byte-canonical. */
export function parseCanonical(label, text) {
  let value;
  try { value = JSON.parse(text); } catch { return fail(`${label} is not JSON`); }
  const duplicate = findDuplicateJsonKey(text);
  if (duplicate !== undefined) fail(`${label} has a duplicate key ${JSON.stringify(duplicate)}`);
  if (`${JSON.stringify(value, null, 2)}\n` !== text) fail(`${label} is not byte-canonical (expected JSON.stringify(value, null, 2) plus one trailing newline)`);
  return value;
}

function assertChain(label, entries) {
  let prev = ZERO_HASH;
  for (const [position, entry] of entries.entries()) {
    if (!isPlainObject(entry)) fail(`${label}: entry ${position + 1} is not an object`);
    if (entry.index !== position + 1) fail(`${label}: entry ${position + 1} has index ${JSON.stringify(entry.index)} (an entry was removed or reordered)`);
    if (entry.prev !== prev) fail(`${label}: entry ${position + 1} prev does not match the previous entry (the record was edited)`);
    prev = sha256Hex(jcs(entry));
  }
}
function assertKeys(label, keys) {
  for (const [position, entry] of keys.entries()) {
    if (!hasExactly(entry, ["keyId", "publicKey", "addedIn"]) || typeof entry.keyId !== "string" || typeof entry.addedIn !== "string" ||
      typeof entry.publicKey !== "string" || !/^[0-9a-f]{64}$/.test(entry.publicKey)) fail(`${label}: key ${position + 1} is malformed`);
    const derived = `t1-${createHash("sha256").update(`${KEY_ID_DOMAIN}\n`).update(Buffer.from(entry.publicKey, "hex")).digest("hex").slice(0, 32)}`;
    if (derived !== entry.keyId) fail(`${label}: key ${position + 1} keyId does not match its public key`);
  }
}
function assertPrefix(label, baseEntries, headEntries) {
  if (headEntries.length < baseEntries.length) fail(`${label}: ${baseEntries.length - headEntries.length} entr(y/ies) removed`);
  for (const [index, entry] of baseEntries.entries()) {
    if (jcs(entry) !== jcs(headEntries[index])) fail(`${label}: entry ${index + 1} was edited, reordered or re-chained (base entries must be an unchanged prefix of head entries)`);
  }
}

/**
 * Checks one base/head pair. Each side is a map file name -> text (undefined
 * when the file does not exist at that ref). Returns a summary of what was
 * appended.
 */
export function checkTrustAppendOnly(base, head) {
  for (const name of FORBIDDEN_FILES) if (head[name] !== undefined) fail(`${TRUST_PATH}/${name} is a local test-fixture marker and must never be committed`);
  for (const name of CANONICAL_FILES) {
    if (head[name] !== undefined && !Object.values(APPEND_ONLY_FILES).includes(name)) parseCanonical(`${TRUST_PATH}/${name}`, head[name]);
  }
  const added = {};
  for (const [kind, name] of Object.entries(APPEND_ONLY_FILES)) {
    const label = `${TRUST_PATH}/${name}`;
    if (base[name] !== undefined && head[name] === undefined) fail(`${label} was deleted`);
    if (head[name] === undefined) continue;
    const headValue = parseCanonical(label, head[name]);
    // The base side was accepted when it landed; it only has to be JSON here.
    let baseValue;
    if (base[name] !== undefined) { try { baseValue = JSON.parse(base[name]); } catch { fail(`${label} (base) is not JSON`); } }
    if (kind === "keys") {
      if (!hasExactly(headValue, ["format", "networkClass", "purpose", "keys"]) || headValue.format !== FORMATS.keys || headValue.networkClass !== "testnet" ||
        headValue.purpose !== "open-testnet-restore-summary" || !Array.isArray(headValue.keys)) fail(`${label}: the pinned key file is malformed`);
      assertKeys(label, headValue.keys);
      if (baseValue && (baseValue.format !== headValue.format || baseValue.networkClass !== headValue.networkClass || baseValue.purpose !== headValue.purpose)) fail(`${label}: format, networkClass or purpose changed`);
      const baseKeys = Array.isArray(baseValue?.keys) ? baseValue.keys : [];
      assertPrefix(label, baseKeys, headValue.keys);
      added[name] = headValue.keys.length - baseKeys.length;
    } else {
      if (!hasExactly(headValue, ["format", "entries"]) || headValue.format !== FORMATS[kind] || !Array.isArray(headValue.entries)) fail(`${label}: the file is malformed`);
      assertChain(label, headValue.entries);
      if (baseValue && baseValue.format !== headValue.format) fail(`${label}: format changed`);
      const baseEntries = Array.isArray(baseValue?.entries) ? baseValue.entries : [];
      assertPrefix(label, baseEntries, headValue.entries);
      added[name] = headValue.entries.length - baseEntries.length;
    }
  }
  return added;
}

const gitIn = (cwd) => (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const isCommit = (git, ref) => { try { git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]); return true; } catch { return false; } };

/**
 * Resolves the base commit for one mode. Returns { base, note }; base is null
 * for an empty base (root commit pushed with an all-zero before SHA).
 */
export function resolveBase({ mode, value, head = "HEAD" }, git) {
  if (!REF.test(String(value ?? "")) || !REF.test(head)) fail("usage: t1-trust-append-only.mjs (--base <ref> | --merge-base <ref> | --push-before <sha>) [--head <ref>]");
  if (!isCommit(git, head)) fail(`cannot compare: head ${head} is not a commit`);
  if (mode === "base") {
    if (!isCommit(git, value)) fail(`cannot compare: base ${value} is not a commit (fetch it first)`);
    return { base: git(["rev-parse", `${value}^{commit}`]), note: `base ${value}` };
  }
  if (mode === "merge-base") {
    if (!isCommit(git, value)) fail(`cannot compare: ${value} is not a commit (fetch it first)`);
    let base;
    try { base = git(["merge-base", value, head]); } catch { return fail(`cannot compare: no merge base of ${value} and ${head} (fetch full history)`); }
    return { base, note: `merge-base of ${value} and ${head}` };
  }
  if (mode === "push-before") {
    if (ZERO_SHA.test(value)) {
      if (isCommit(git, `${head}^1`)) return { base: git(["rev-parse", `${head}^1`]), note: "all-zero before SHA: first parent of the head" };
      return { base: null, note: "all-zero before SHA and a root commit: empty base" };
    }
    if (!isCommit(git, value)) fail(`cannot compare: push before SHA ${value} is not a known commit (fetch full history)`);
    return { base: git(["rev-parse", `${value}^{commit}`]), note: `push before ${value}` };
  }
  return fail("usage: one of --base, --merge-base or --push-before is required");
}

export function filesAt(ref, git) {
  const out = {};
  for (const name of [...CANONICAL_FILES, ...FORBIDDEN_FILES]) {
    if (ref === null) { out[name] = undefined; continue; }
    try { out[name] = execFileSync("git", ["show", `${ref}:${TRUST_PATH}/${name}`], { cwd: git.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { out[name] = undefined; }
  }
  return out;
}

export function runCli(args, { cwd = process.cwd() } = {}) {
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const modes = ["base", "merge-base", "push-before"].filter((mode) => args.includes(`--${mode}`));
  if (modes.length !== 1) fail("usage: t1-trust-append-only.mjs (--base <ref> | --merge-base <ref> | --push-before <sha>) [--head <ref>]");
  const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  const git = gitIn(repo);
  git.cwd = repo;
  const head = value("--head") ?? "HEAD";
  const { base, note } = resolveBase({ mode: modes[0], value: value(`--${modes[0]}`), head }, git);
  const added = checkTrustAppendOnly(filesAt(base, git), filesAt(head, git));
  return `t1-trust-append-only: ok (${note}: ${base ?? "empty"} -> ${head}; appended ${JSON.stringify(added)})`;
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  try {
    console.log(runCli(process.argv.slice(2)));
  } catch (error) {
    console.error(`t1-trust-append-only: ${error instanceof TrustAppendOnlyError ? error.message : `cannot compare: ${error instanceof Error ? error.message : String(error)}`}`);
    process.exit(1);
  }
}
