import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  readCliCheckpointSnapshotAnchoredUtf8
} from "../src/cli-recovery-file.js";
import { MAX_CHECKPOINT_JSON_NESTING_DEPTH } from "../src/checkpoint-json-complexity.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const checkpointDigestMismatch = /checkpoint snapshot digest mismatch.*SHA-256/i;

test("anchored CLI checkpoint reader preserves canonical snapshot digest across writer LF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-checkpoint-digest-valid-"));
  try {
    const path = join(dir, "snapshot.json");
    const canonical = JSON.stringify({ version: 1, checkpoint: "trusted" });
    const fileBody = `${canonical}\n`;
    await writeFile(path, fileBody);
    assert.equal(await readCliCheckpointSnapshotAnchoredUtf8(path, sha256(canonical)), fileBody);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("anchored CLI checkpoint reader does not redefine the anchor as a whole-file digest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-checkpoint-digest-file-bytes-"));
  try {
    const path = join(dir, "snapshot.json");
    const canonical = JSON.stringify({ version: 1, checkpoint: "trusted" });
    const fileBody = `${canonical}\n`;
    await writeFile(path, fileBody);
    await assert.rejects(
      () => readCliCheckpointSnapshotAnchoredUtf8(path, sha256(fileBody)),
      checkpointDigestMismatch
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("anchored CLI checkpoint reader rejects alternate formatting before JSON parsing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-checkpoint-digest-format-"));
  try {
    const path = join(dir, "snapshot.json");
    const canonical = JSON.stringify({ version: 1, checkpoint: "trusted" });
    const formatted = '{\n  "version": 1,\n  "checkpoint": "trusted"\n}\n';
    await writeFile(path, formatted);
    await assert.rejects(
      () => readCliCheckpointSnapshotAnchoredUtf8(path, sha256(canonical)),
      checkpointDigestMismatch
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("anchored CLI checkpoint reader rejects digest mismatch before complexity scanning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-cli-checkpoint-digest-order-"));
  try {
    const path = join(dir, "snapshot.json");
    const overComplex = `${"[".repeat(MAX_CHECKPOINT_JSON_NESTING_DEPTH + 1)}0${"]".repeat(MAX_CHECKPOINT_JSON_NESTING_DEPTH + 1)}`;
    await writeFile(path, overComplex);
    await assert.rejects(
      () => readCliCheckpointSnapshotAnchoredUtf8(path, "0".repeat(64)),
      checkpointDigestMismatch
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("anchored CLI checkpoint reader rejects malformed digest anchors before file access", async () => {
  await assert.rejects(
    () => readCliCheckpointSnapshotAnchoredUtf8("/definitely/not/a/checkpoint.json", "ABC"),
    /lowercase 32-byte SHA-256 anchor/
  );
});

test("published secure CLI binds checkpoint staging to the --sha256 anchor", async () => {
  const source = await readFile(new URL("../../src/secure-cli.ts", import.meta.url), "utf8");
  assert.match(source, /readCliCheckpointSnapshotAnchoredUtf8/);
  assert.match(source, /optionValueIndex\(args, "--sha256"\)/);
  assert.match(source, /readCliCheckpointSnapshotAnchoredUtf8\(path, expectedSha256\)/);
});