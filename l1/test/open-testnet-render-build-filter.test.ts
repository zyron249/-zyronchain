// The Render blueprint auto-deploys on every commit to main, and each deploy
// restarts the free open-testnet instance (blocks after the last published
// snapshot are lost). A build filter limits deploys to changes that can affect
// the service: the l1 package it builds and runs, and its deploy directory.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const blueprintPath = fileURLToPath(new URL("../../../deploy/open-testnet/render.yaml", import.meta.url));

// Minimal reader for the block-style lists in this blueprint (no YAML dependency).
function listUnder(lines: string[], parent: string, key: string): string[] | undefined {
  const parentIndex = lines.findIndex((line) => line.trim() === `${parent}:`);
  if (parentIndex < 0) return undefined;
  const parentIndent = (lines[parentIndex] ?? "").search(/\S/);
  const items: string[] = [];
  let inKey = false;
  let keyIndent = -1;
  for (const line of lines.slice(parentIndex + 1)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent <= parentIndent) break;
    if (line.trim() === `${key}:`) { inKey = true; keyIndent = indent; continue; }
    if (inKey && indent <= keyIndent && !line.trim().startsWith("- ")) inKey = false;
    if (inKey && line.trim().startsWith("- ")) items.push(line.trim().slice(2).trim().replace(/^["']|["']$/g, ""));
  }
  return items;
}

test("open-testnet blueprint only deploys for changes under l1/ or its deploy directory", async () => {
  const text = await readFile(blueprintPath, "utf8");
  const lines = text.split("\n");
  const paths = listUnder(lines, "buildFilter", "paths");
  assert.ok(paths, "render.yaml has no buildFilter: every docs-only merge restarts the testnet");
  assert.deepEqual([...paths].sort(), ["deploy/open-testnet/**", "l1/**"]);
  const ignored = listUnder(lines, "buildFilter", "ignoredPaths") ?? [];
  assert.deepEqual(ignored, [], "nothing under l1/ may be ignored: build and runtime inputs live there");

  // Everything the service builds and runs is inside l1/, so the filter covers it.
  const buildCommand = /^\s*buildCommand:\s*(.+)$/m.exec(text)?.[1] ?? "";
  const startCommand = /^\s*startCommand:\s*(.+)$/m.exec(text)?.[1] ?? "";
  assert.match(buildCommand, /^cd l1 && npm ci && npm run build$/);
  assert.match(startCommand, /^cd l1 && node scripts\/open-testnet\.mjs run /);
});
