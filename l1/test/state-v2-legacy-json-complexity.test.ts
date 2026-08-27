import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { StateV2DiskStore } from "../src/state-v2-store.js";

test("legacy State-v2 migration rejects deeply nested complete node JSON before parse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-json-depth-"));
  try {
    const nested = `${"[".repeat(65)}0${"]".repeat(65)}`;
    await writeFile(join(directory, "state-v2.nodes.ndjson"), `{"record":${nested},"checksum":"${"0".repeat(64)}"}\n`, { mode: 0o600 });
    await assert.rejects(
      () => StateV2DiskStore.open(directory),
      /State v2 legacy node JSON nesting exceeds 64/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy State-v2 migration rejects punctuation-dense semantic-key JSON before parse", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-json-density-"));
  try {
    await writeFile(join(directory, "state-v2.nodes.ndjson"), "", { mode: 0o600 });
    const dense = `[${Array.from({ length: 140 }, () => "0").join(",")}]`;
    await writeFile(
      join(directory, "state-v2.keys.ndjson"),
      `{"key":"x","extra":${dense},"checksum":"${"0".repeat(64)}"}\n`,
      { mode: 0o600 }
    );
    await assert.rejects(
      () => StateV2DiskStore.open(directory),
      /State v2 legacy semantic key JSON structure exceeds 128 token limit/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy State-v2 JSON complexity scan ignores punctuation inside quoted strings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-json-quoted-"));
  try {
    await writeFile(join(directory, "state-v2.nodes.ndjson"), "", { mode: 0o600 });
    const punctuation = "[{,:}]".repeat(40);
    const body = { key: punctuation };
    const { canonicalJson, sha256Hex } = await import("../src/codec.js");
    const line = canonicalJson({ ...body, checksum: sha256Hex(canonicalJson(body)) });
    await writeFile(join(directory, "state-v2.keys.ndjson"), `${line}\n`, { mode: 0o600 });
    const store = await StateV2DiskStore.open(directory);
    assert.ok(store);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
