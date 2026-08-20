import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

test("trusted checkpoint fetch assembles into one bounded destination buffer", async () => {
  const source = await readFile(resolve(process.cwd(), "src", "p2p-checkpoint.ts"), "utf8");
  const start = source.indexOf("export async function fetchTrustedSnapshotFromPeer");
  const end = source.indexOf("\nfunction snapshotForServing", start);
  assert.ok(start >= 0 && end > start, "checkpoint fetch implementation must be present");
  const fetchSource = source.slice(start, end);

  assert.doesNotMatch(fetchSource, /const\s+chunks\s*:\s*Buffer\[\]/);
  assert.doesNotMatch(fetchSource, /chunks\.push\s*\(/);
  assert.doesNotMatch(fetchSource, /Buffer\.concat\s*\(\s*chunks\b/);
  assert.match(fetchSource, /snapshotBytes\s*=\s*Buffer\.allocUnsafe\(totalBytes\)/);
  assert.match(fetchSource, /bytes\.copy\(snapshotBytes,\s*offset\)/);
  assert.match(fetchSource, /offset\s*!==\s*totalBytes/);
  assert.match(fetchSource, /sha256Hex\(snapshotBytes\)\s*!==\s*anchor\.snapshotSha256/);
  assert.match(fetchSource, /assertBoundedCheckpointJsonStructure\(snapshotBytes\)/);
  assert.match(fetchSource, /let\s+text\s*=\s*snapshotBytes\.toString\("utf8"\)/);
  assert.match(fetchSource, /snapshotBytes\s*=\s*undefined/);
  assert.match(fetchSource, /value\s*=\s*JSON\.parse\(text\)/);
  assert.ok(
    fetchSource.indexOf("assertBoundedCheckpointJsonStructure(snapshotBytes)") < fetchSource.indexOf("JSON.parse(text)"),
    "checkpoint complexity scan must run before JSON.parse"
  );
  assert.match(fetchSource, /text\s*=\s*""/);
  assert.match(fetchSource, /const\s+canonical\s*=\s*canonicalJson\(value\)/);
  assert.match(fetchSource, /sha256Hex\(canonical\)\s*!==\s*anchor\.snapshotSha256/);
  assert.doesNotMatch(fetchSource, /sha256Hex\(text\)\s*!==\s*anchor\.snapshotSha256/);
  assert.doesNotMatch(fetchSource, /canonicalJson\(value\)\s*!==\s*text/);
});
