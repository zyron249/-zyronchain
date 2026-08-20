#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = 'l1/src/state-v2-store.ts';
const testPath = 'l1/test/state-v2-metadata-security.test.ts';

let source = await readFile(sourcePath, 'utf8');
const oldImport = 'import { constants } from "node:fs";\n';
if (!source.includes(oldImport)) throw new Error('expected legacy constants import');
source = source.replace(oldImport, '');
const anchorImport = 'import { canonicalJson, sha256Hex } from "./codec.js";\n';
if (!source.includes(anchorImport)) throw new Error('expected codec import');
source = source.replace(anchorImport, 'import { readBoundedUtf8File, type BoundedFileFaultHooks } from "./bounded-file.js";\n' + anchorImport);

const oldReader = `export async function readStateV2MetadataFile(\n  path: string,\n  maxBytes = STATE_V2_METADATA_MAX_BYTES\n): Promise<string> {\n  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid State v2 metadata byte limit");\n  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;\n  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;\n  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);\n  try {\n    const info = await handle.stat();\n    if (!info.isFile() || info.size < 1 || info.size > maxBytes) {\n      throw new Error("State v2 metadata exceeds byte bounds or is not a regular file");\n    }\n    const buffer = Buffer.allocUnsafe(maxBytes + 1);\n    let total = 0;\n    while (total <= maxBytes) {\n      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);\n      if (bytesRead === 0) break;\n      total += bytesRead;\n      if (total > maxBytes) throw new Error("State v2 metadata exceeds byte bounds");\n    }\n    if (total < 1) throw new Error("State v2 metadata exceeds byte bounds or is not a regular file");\n    return buffer.subarray(0, total).toString("utf8");\n  } finally {\n    await handle.close();\n  }\n}\n`;
const newReader = `export async function readStateV2MetadataFile(\n  path: string,\n  maxBytes = STATE_V2_METADATA_MAX_BYTES,\n  faultHooks: BoundedFileFaultHooks = {}\n): Promise<string> {\n  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid State v2 metadata byte limit");\n  const text = await readBoundedUtf8File(path, maxBytes, "State v2 metadata", faultHooks);\n  if (text.length < 1) throw new Error("State v2 metadata exceeds byte bounds or is not a regular file");\n  return text;\n}\n`;
if (!source.includes(oldReader)) throw new Error('expected legacy State-v2 metadata reader');
source = source.replace(oldReader, newReader);
await writeFile(sourcePath, source);

let test = await readFile(testPath, 'utf8');
test = test.replace(
  'import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";',
  'import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";'
);
test = test.replace('/byte bounds/', '/byte limit|byte bounds/');
const oldSymlink = `test("State-v2 metadata reader rejects a symlink instead of following it", { skip: process.platform === "win32" }, async () => {\n  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-metadata-symlink-"));\n  const target = join(directory, "target.json");\n  const path = join(directory, "metadata.json");\n  try {\n    await writeFile(target, "canonical", "utf8");\n    await symlink(target, path);\n    await assert.rejects(\n      () => readStateV2MetadataFile(path, 64),\n      (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ELOOP")\n    );\n  } finally {\n    await rm(directory, { recursive: true, force: true });\n  }\n});\n`;
const newSymlink = `test("State-v2 metadata reader rejects a symlink instead of following it", { skip: process.platform === "win32" }, async () => {\n  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-metadata-symlink-"));\n  const target = join(directory, "target.json");\n  const path = join(directory, "metadata.json");\n  try {\n    await writeFile(target, "canonical", "utf8");\n    await symlink(target, path);\n    await assert.rejects(() => readStateV2MetadataFile(path, 64), /symbolic link/);\n  } finally {\n    await rm(directory, { recursive: true, force: true });\n  }\n});\n\ntest("State-v2 metadata reader rejects parent path substitution after open", async (t) => {\n  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-metadata-substitution-"));\n  const live = join(directory, "live");\n  const moved = join(directory, "moved");\n  const replacement = join(directory, "replacement");\n  const path = join(live, "metadata.json");\n  try {\n    await mkdir(live);\n    await mkdir(replacement);\n    await writeFile(path, "canonical", "utf8");\n    await writeFile(join(replacement, "metadata.json"), "substituted", "utf8");\n    await assert.rejects(\n      () => readStateV2MetadataFile(path, 64, {\n        afterOpenValidated: async () => {\n          await rename(live, moved);\n          try {\n            await symlink(replacement, live, process.platform === "win32" ? "junction" : "dir");\n          } catch (error) {\n            if (process.platform === "win32" && error && typeof error === "object" && "code" in error &&\n                ["EPERM", "EACCES", "UNKNOWN"].includes(String((error).code))) {\n              t.skip("Windows runner cannot create a junction for substitution regression");\n              return;\n            }\n            throw error;\n          }\n        }\n      }),\n      /changed during reading|regular file|symbolic link/\n    );\n  } finally {\n    await rm(directory, { recursive: true, force: true });\n  }\n});\n`;
if (!test.includes(oldSymlink)) throw new Error('expected legacy State-v2 metadata symlink regression');
test = test.replace(oldSymlink, newSymlink);
await writeFile(testPath, test);
