// CI guard: every open-testnet port window is claimed by exactly one source
// file, every claim names a registered window, the registered windows are
// disjoint and below the ephemeral range, and no test hardcodes a base port.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { assertDisjointPortWindows, EPHEMERAL_PORT_FLOOR, OPEN_TESTNET_PORT_WINDOWS } from "./helpers/open-testnet-ports.js";

const roots = ["../../test/", "../../scripts/"].map((path) => new URL(path, import.meta.url));
const claimPattern = /allocateValidatorBasePort\(\s*["']([^"']+)["']/g;
const hardcodedBasePort = /\bbasePort\s*:\s*\d/;

async function sources(): Promise<Array<{ file: string; text: string }>> {
  const out: Array<{ file: string; text: string }> = [];
  for (const root of roots) {
    for (const entry of await readdir(root, { recursive: true })) {
      const name = String(entry);
      if (!/\.(ts|mjs|js)$/.test(name) || name.includes("node_modules")) continue;
      out.push({ file: `${root.pathname.split("/").slice(-2, -1)[0]}/${name}`, text: await readFile(new URL(name, root), "utf8") });
    }
  }
  return out;
}

test("each open-testnet port window is claimed by exactly one file and all windows are disjoint below 32768", async () => {
  assertDisjointPortWindows();
  const sorted = Object.entries(OPEN_TESTNET_PORT_WINDOWS).sort((a, b) => a[1][0] - b[1][0]);
  for (const [name, [lo, hi]] of sorted) assert.ok(lo < hi && hi <= EPHEMERAL_PORT_FLOOR, `${name} [${lo}, ${hi}) reaches ${EPHEMERAL_PORT_FLOOR}`);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i]![1][0] >= sorted[i - 1]![1][1], `${sorted[i - 1]![0]} overlaps ${sorted[i]![0]}`);

  const owners = new Map<string, Set<string>>();
  for (const { file, text } of await sources()) {
    for (const match of text.matchAll(claimPattern)) {
      const window = match[1]!;
      assert.ok(Object.hasOwn(OPEN_TESTNET_PORT_WINDOWS, window), `${file} claims unregistered port window ${window}`);
      if (!owners.has(window)) owners.set(window, new Set());
      owners.get(window)!.add(file);
    }
  }
  for (const [window, files] of owners) assert.equal(files.size, 1, `port window ${window} is claimed by more than one file: ${[...files].join(", ")}`);
  for (const window of Object.keys(OPEN_TESTNET_PORT_WINDOWS)) assert.ok(owners.has(window), `port window ${window} is registered but never claimed`);
});

test("no l1 test file passes a hardcoded validator base port", async () => {
  for (const { file, text } of await sources()) {
    if (!file.startsWith("test/")) continue;
    assert.equal(hardcodedBasePort.test(text), false, `${file} hardcodes basePort; use allocateValidatorBasePort with its own window`);
  }
});
