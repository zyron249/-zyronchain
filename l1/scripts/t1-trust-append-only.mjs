#!/usr/bin/env node
// S2-3 T1: l1/trust/ is append-only (docs/specs/s2-3-t1-sealed-summary.md).
//
//   node l1/scripts/t1-trust-append-only.mjs --base <git ref> [--head <git ref>]
//
// Compares the trust files at the PR base with the PR head (read with
// `git show <ref>:l1/trust/<file>`) and fails unless:
//   - t1-summary-record.json and t1-high-water.json at head parse (valid
//     index / prev hash chain) and the base entries are an unchanged prefix of
//     the head entries (byte-identical canonical JSON, same positions), so no
//     entry is edited, removed, reordered or re-chained;
//   - every pinned key at base is still pinned, unchanged, at the same position
//     at head (keys are only ADDED; revocation and rotation go through the
//     record, never through edits);
//   - none of these files is deleted, and the loopback test-fixture marker is
//     never present.
// The seal text and the quorum config may change (a new seal replaces the old
// one together with its appended high-water entry).
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const api = await import(pathToFileURL(join(l1Root, "dist/src/sealed-summary.js")).href);
const { canonicalJson } = await import(pathToFileURL(join(l1Root, "dist/src/codec.js")).href);

export const TRUST_PATH = "l1/trust";
export const APPEND_ONLY_FILES = Object.freeze({ keys: "t1-summary-keys.json", record: "t1-summary-record.json", highWater: "t1-high-water.json" });
export const FORBIDDEN_FILES = Object.freeze(["TEST-FIXTURE-ONLY-loopback-quorum"]);

export class TrustAppendOnlyError extends Error {}
const fail = (message) => { throw new TrustAppendOnlyError(message); };

const sameEntry = (a, b) => canonicalJson(a) === canonicalJson(b);
function assertPrefix(label, baseEntries, headEntries) {
  if (headEntries.length < baseEntries.length) fail(`${label}: ${baseEntries.length - headEntries.length} entr(y/ies) removed`);
  for (const [index, entry] of baseEntries.entries()) {
    if (!sameEntry(entry, headEntries[index])) fail(`${label}: entry ${index + 1} was edited, reordered or re-chained (base entries must be an unchanged prefix of head entries)`);
  }
}
const parse = (label, text) => { try { return JSON.parse(text); } catch { return fail(`${label} is not JSON`); } };
const strict = (label, fn) => { try { return fn(); } catch (error) { return fail(`${label}: ${error instanceof Error ? error.message : String(error)}`); } };

/**
 * Checks one base/head pair. Each side is a map file name -> text (undefined
 * when the file does not exist at that ref). Returns a summary of what was
 * appended.
 */
export function checkTrustAppendOnly(base, head) {
  for (const name of FORBIDDEN_FILES) if (head[name] !== undefined) fail(`${TRUST_PATH}/${name} is a local test-fixture marker and must never be committed`);
  const added = {};
  for (const [kind, name] of Object.entries(APPEND_ONLY_FILES)) {
    const label = `${TRUST_PATH}/${name}`;
    if (base[name] !== undefined && head[name] === undefined) fail(`${label} was deleted`);
    if (head[name] === undefined) continue;
    const headValue = parse(label, head[name]);
    const baseValue = base[name] === undefined ? undefined : parse(`${label} (base)`, base[name]);
    if (kind === "keys") {
      strict(label, () => api.parsePinnedKeysFile(headValue));
      const baseKeys = baseValue?.keys ?? [];
      if (baseValue && (baseValue.format !== headValue.format || baseValue.networkClass !== headValue.networkClass || baseValue.purpose !== headValue.purpose)) fail(`${label}: format, networkClass or purpose changed`);
      assertPrefix(label, baseKeys, headValue.keys);
      added[name] = headValue.keys.length - baseKeys.length;
    } else {
      strict(label, () => (kind === "record" ? api.parseRecordFile : api.parseHighWaterFile)(headValue));
      const baseEntries = baseValue?.entries ?? [];
      if (baseValue && baseValue.format !== headValue.format) fail(`${label}: format changed`);
      assertPrefix(label, baseEntries, headValue.entries);
      added[name] = headValue.entries.length - baseEntries.length;
    }
  }
  return added;
}

function filesAt(ref, cwd) {
  const out = {};
  for (const name of [...Object.values(APPEND_ONLY_FILES), ...FORBIDDEN_FILES]) {
    try { out[name] = execFileSync("git", ["show", `${ref}:${TRUST_PATH}/${name}`], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { out[name] = undefined; }
  }
  return out;
}

const invokedDirectly = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invokedDirectly) {
  const args = process.argv.slice(2);
  const value = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  const base = value("--base");
  const headRef = value("--head") ?? "HEAD";
  try {
    if (!base || !/^[0-9A-Za-z._/~^-]{1,200}$/.test(base) || !/^[0-9A-Za-z._/~^-]{1,200}$/.test(headRef)) fail("usage: t1-trust-append-only.mjs --base <git ref> [--head <git ref>]");
    const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: l1Root, encoding: "utf8" }).trim();
    execFileSync("git", ["rev-parse", "--verify", `${base}^{commit}`], { cwd: repo, stdio: "ignore" });
    const added = checkTrustAppendOnly(filesAt(base, repo), filesAt(headRef, repo));
    console.log(`t1-trust-append-only: ok (${base} -> ${headRef}; appended ${JSON.stringify(added)})`);
  } catch (error) {
    console.error(`t1-trust-append-only: ${error instanceof TrustAppendOnlyError ? error.message : `cannot compare: ${error instanceof Error ? error.message : String(error)}`}`);
    process.exit(1);
  }
}
