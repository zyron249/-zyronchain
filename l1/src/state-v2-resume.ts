import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalJson, sha256Hex } from "./codec.js";
import {
  MAX_PORTABLE_STATE_KEYS,
  MAX_PORTABLE_STATE_NODES,
  type StateV2PortableBundleV1
} from "./state-v2-portable.js";
import type { Block } from "./types.js";

const MANIFEST_FILE = "manifest.json";
const RECORDS_DIR = "records";
const KEYS_DIR = "keys";
const TEMP_DIR = ".tmp";
const MAX_RESUME_CHUNK_FILE_BYTES = 20 * 1024 * 1024;

export interface PortableStateResumeManifestV1 {
  version: 1;
  chainId: string;
  genesisHash: string;
  tipHash: string;
  snapshotSha256: string;
  height: number;
  stateRoot: string;
  recordCount: number;
  keyCount: number;
  tip: Block;
}

export interface PortableStateResumeReadFaultHooks {
  afterPreflight?: () => void | Promise<void>;
  afterOpen?: () => void | Promise<void>;
}

interface ManifestEnvelope {
  manifest: PortableStateResumeManifestV1;
  checksum: string;
}

interface ChunkBody {
  version: 1;
  start: number;
  items: unknown[];
}

interface ChunkEnvelope extends ChunkBody {
  checksum: string;
}

interface ChunkIndex { start: number; length: number }

/**
 * Crash-safe, untrusted download staging for portable State-v2 chunks. These
 * files are never node state: the complete bundle still has to pass the
 * external checkpoint anchor and Merkle/finality validation before publish.
 */
export class PortableStateResumeStore {
  private constructor(
    readonly dataDir: string,
    readonly manifest: PortableStateResumeManifestV1,
    private recordProgress: number,
    private keyProgress: number,
    private readonly recordChunks: ChunkIndex[],
    private readonly keyChunks: ChunkIndex[]
  ) {}

  static async open(dataDir: string, manifest: PortableStateResumeManifestV1): Promise<PortableStateResumeStore> {
    validateManifest(manifest);
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    await assertRealDirectory(dataDir);
    const recordsDir = join(dataDir, RECORDS_DIR);
    const keysDir = join(dataDir, KEYS_DIR);
    const tempDir = join(dataDir, TEMP_DIR);
    await mkdir(recordsDir, { recursive: true, mode: 0o700 });
    await mkdir(keysDir, { recursive: true, mode: 0o700 });
    await assertRealDirectory(recordsDir);
    await assertRealDirectory(keysDir);
    await rm(tempDir, { recursive: true, force: true });
    await mkdir(tempDir, { mode: 0o700 });
    await assertRealDirectory(tempDir);
    const path = join(dataDir, MANIFEST_FILE);
    try {
      const existing = parseManifestEnvelope(await readPortableStateResumeFile(path, 3_000_000));
      if (canonicalJson(existing.manifest) !== canonicalJson(manifest)) {
        throw new Error("Portable state resume manifest does not match requested checkpoint");
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await atomicWrite(path, manifestEnvelope(manifest), tempDir);
    }
    const records = await scanProgress(join(dataDir, RECORDS_DIR), manifest.recordCount, MAX_PORTABLE_STATE_NODES);
    const keys = await scanProgress(join(dataDir, KEYS_DIR), manifest.keyCount, MAX_PORTABLE_STATE_KEYS);
    return new PortableStateResumeStore(
      dataDir, structuredClone(manifest), records.progress, keys.progress, records.chunks, keys.chunks
    );
  }

  static async openExisting(dataDir: string, expected: {
    chainId: string;
    genesisHash: string;
    tipHash: string;
    snapshotSha256: string;
  }): Promise<PortableStateResumeStore> {
    await assertRealDirectory(dataDir);
    const envelope = parseManifestEnvelope(await readPortableStateResumeFile(join(dataDir, MANIFEST_FILE), 3_000_000));
    const manifest = envelope.manifest;
    if (manifest.chainId !== expected.chainId || manifest.genesisHash !== expected.genesisHash ||
        manifest.tipHash !== expected.tipHash || manifest.snapshotSha256 !== expected.snapshotSha256) {
      throw new Error("Portable state resume manifest does not match requested checkpoint");
    }
    return PortableStateResumeStore.open(dataDir, manifest);
  }

  nextRecordStart(): number { return this.recordProgress; }
  nextKeyStart(): number { return this.keyProgress; }

  async putRecords(start: number, items: unknown[]): Promise<void> {
    this.recordProgress = await this.put(RECORDS_DIR, this.recordProgress, this.manifest.recordCount, start, items);
    this.recordChunks.push({ start, length: items.length });
  }

  async putKeys(start: number, items: unknown[]): Promise<void> {
    this.keyProgress = await this.put(KEYS_DIR, this.keyProgress, this.manifest.keyCount, start, items);
    this.keyChunks.push({ start, length: items.length });
  }

  async records(start: number, limit: number): Promise<unknown[]> {
    return readRange(join(this.dataDir, RECORDS_DIR), this.recordChunks, this.manifest.recordCount, start, limit);
  }

  async keys(start: number, limit: number): Promise<unknown[]> {
    return readRange(join(this.dataDir, KEYS_DIR), this.keyChunks, this.manifest.keyCount, start, limit);
  }

  complete(): boolean {
    return this.recordProgress === this.manifest.recordCount && this.keyProgress === this.manifest.keyCount;
  }

  async bundle(): Promise<StateV2PortableBundleV1> {
    if (!this.complete()) throw new Error("Portable state resume is incomplete");
    const records = await collectItems(join(this.dataDir, RECORDS_DIR), this.manifest.recordCount);
    const keyPreimages = await collectItems(join(this.dataDir, KEYS_DIR), this.manifest.keyCount);
    return {
      version: 1,
      root: this.manifest.stateRoot,
      records,
      keyPreimages
    } as unknown as StateV2PortableBundleV1;
  }

  async discard(): Promise<void> {
    await rm(this.dataDir, { recursive: true, force: true });
  }

  private async put(directory: string, progress: number, total: number, start: number, items: unknown[]): Promise<number> {
    if (!Number.isSafeInteger(start) || start !== progress || !Array.isArray(items) || items.length < 1 || start + items.length > total) {
      throw new Error("Portable state resume chunk is not the exact next range");
    }
    const path = join(this.dataDir, directory, `${start}.json`);
    const body: ChunkBody = { version: 1, start, items: structuredClone(items) };
    const envelope: ChunkEnvelope = { ...body, checksum: sha256Hex(canonicalJson(body)) };
    const text = `${canonicalJson(envelope)}\n`;
    if (Buffer.byteLength(text, "utf8") > MAX_RESUME_CHUNK_FILE_BYTES) throw new Error("Portable state resume chunk exceeds disk byte limit");
    await atomicWrite(path, text, join(this.dataDir, TEMP_DIR));
    return start + items.length;
  }
}

function manifestEnvelope(manifest: PortableStateResumeManifestV1): string {
  const envelope: ManifestEnvelope = {
    manifest: structuredClone(manifest),
    checksum: sha256Hex(canonicalJson(manifest))
  };
  return `${canonicalJson(envelope)}\n`;
}

function parseManifestEnvelope(text: string): ManifestEnvelope {
  const value = JSON.parse(text) as Partial<ManifestEnvelope>;
  if (!value || typeof value !== "object" || !value.manifest || typeof value.checksum !== "string") {
    throw new Error("Corrupt portable state resume manifest");
  }
  validateManifest(value.manifest);
  if (sha256Hex(canonicalJson(value.manifest)) !== value.checksum || text !== manifestEnvelope(value.manifest)) {
    throw new Error("Portable state resume manifest checksum mismatch");
  }
  return value as ManifestEnvelope;
}

function validateManifest(value: PortableStateResumeManifestV1): void {
  if (value.version !== 1 || typeof value.chainId !== "string" || value.chainId.length < 1 || value.chainId.length > 128 ||
      !isHash(value.genesisHash) || !isHash(value.tipHash) || !isHash(value.snapshotSha256) || !isHash(value.stateRoot) ||
      !Number.isSafeInteger(value.height) || value.height < 1 ||
      !Number.isSafeInteger(value.recordCount) || value.recordCount < 1 || value.recordCount > MAX_PORTABLE_STATE_NODES ||
      !Number.isSafeInteger(value.keyCount) || value.keyCount < 1 || value.keyCount > MAX_PORTABLE_STATE_KEYS ||
      !value.tip || typeof value.tip !== "object" || Array.isArray(value.tip)) {
    throw new Error("Invalid portable state resume manifest");
  }
}

async function scanProgress(directory: string, total: number, absoluteMax: number): Promise<{ progress: number; chunks: ChunkIndex[] }> {
  const names = await readdir(directory);
  const starts = names.map(parseChunkFilename).sort((a, b) => a - b);
  if (starts.length > absoluteMax) throw new Error("Portable state resume contains too many chunks");
  let progress = 0;
  const chunks: ChunkIndex[] = [];
  for (const start of starts) {
    if (start !== progress) throw new Error("Portable state resume chunks contain a gap, overlap, or unexpected file");
    const chunk = parseChunkEnvelope(await readPortableStateResumeFile(join(directory, `${start}.json`), MAX_RESUME_CHUNK_FILE_BYTES));
    if (chunk.start !== start || chunk.items.length < 1 || start + chunk.items.length > total) {
      throw new Error("Invalid portable state resume chunk range");
    }
    chunks.push({ start, length: chunk.items.length });
    progress += chunk.items.length;
  }
  return { progress, chunks };
}

async function readRange(
  directory: string,
  chunks: readonly ChunkIndex[],
  total: number,
  start: number,
  limit: number
): Promise<unknown[]> {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(limit) || limit < 1 || start + limit > total) {
    throw new Error("Invalid portable state resume read range");
  }
  const result: unknown[] = [];
  const end = start + limit;
  for (const index of chunks) {
    const chunkEnd = index.start + index.length;
    if (chunkEnd <= start) continue;
    if (index.start >= end) break;
    const chunk = parseChunkEnvelope(await readPortableStateResumeFile(join(directory, `${index.start}.json`), MAX_RESUME_CHUNK_FILE_BYTES));
    if (chunk.start !== index.start || chunk.items.length !== index.length) {
      throw new Error("Portable state resume chunk changed after indexing");
    }
    const from = Math.max(start, index.start) - index.start;
    const to = Math.min(end, chunkEnd) - index.start;
    result.push(...chunk.items.slice(from, to));
  }
  if (result.length !== limit) throw new Error("Portable state resume read range is incomplete");
  return result;
}

async function collectItems(directory: string, total: number): Promise<unknown[]> {
  const names = (await readdir(directory)).map(parseChunkFilename).sort((a, b) => a - b);
  const result: unknown[] = [];
  for (const start of names) {
    if (start !== result.length) throw new Error("Portable state resume chunks changed during validation");
    const chunk = parseChunkEnvelope(await readPortableStateResumeFile(join(directory, `${start}.json`), MAX_RESUME_CHUNK_FILE_BYTES));
    if (chunk.start !== start || start + chunk.items.length > total) throw new Error("Invalid portable state resume chunk range");
    result.push(...chunk.items);
  }
  if (result.length !== total) throw new Error("Portable state resume is incomplete");
  return result;
}

function parseChunkEnvelope(text: string): ChunkEnvelope {
  const value = JSON.parse(text) as Partial<ChunkEnvelope>;
  if (value.version !== 1 || !Number.isSafeInteger(value.start) || Number(value.start) < 0 ||
      !Array.isArray(value.items) || typeof value.checksum !== "string") throw new Error("Corrupt portable state resume chunk");
  const body: ChunkBody = { version: 1, start: Number(value.start), items: value.items };
  if (sha256Hex(canonicalJson(body)) !== value.checksum || text !== `${canonicalJson({ ...body, checksum: value.checksum })}\n`) {
    throw new Error("Portable state resume chunk checksum mismatch");
  }
  return { ...body, checksum: value.checksum };
}

function parseChunkFilename(name: string): number {
  if (!/^(0|[1-9][0-9]*)\.json$/.test(name)) throw new Error("Unexpected portable state resume file");
  const start = Number(name.slice(0, -5));
  if (!Number.isSafeInteger(start) || start < 0) throw new Error("Invalid portable state resume chunk filename");
  return start;
}

async function atomicWrite(path: string, text: string, tempDir: string): Promise<void> {
  const temporary = join(tempDir, `${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try { await directory.sync(); } finally { await directory.close(); }
}

/**
 * Read one untrusted resume file from exactly one opened object. The path must
 * remain bound to that same regular file for the duration of the read, and a
 * concurrently growing file is rejected before allocating beyond maxBytes+1.
 */
export async function readPortableStateResumeFile(
  path: string,
  maxBytes: number,
  faultHooks: PortableStateResumeReadFaultHooks = {}
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Invalid portable state resume byte limit");
  const pathBefore = await lstat(path);
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || pathBefore.size < 1 || pathBefore.size > maxBytes) {
    throw new Error("Portable state resume file exceeds byte bounds or is not a regular file");
  }
  await faultHooks.afterPreflight?.();

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const nonBlocking = process.platform === "win32" ? 0 : constants.O_NONBLOCK;
  const handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > maxBytes ||
        opened.dev !== pathBefore.dev || opened.ino !== pathBefore.ino) {
      throw new Error("Portable state resume file changed before descriptor binding");
    }
    await faultHooks.afterOpen?.();

    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let total = 0;
    while (total <= maxBytes) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error("Portable state resume file exceeds byte bounds");
    }
    if (total < 1) throw new Error("Portable state resume file exceeds byte bounds or is not a regular file");

    const pathAfter = await lstat(path);
    if (!pathAfter.isFile() || pathAfter.isSymbolicLink() || pathAfter.dev !== opened.dev || pathAfter.ino !== opened.ino) {
      throw new Error("Portable state resume file changed during bounded read");
    }
    return buffer.subarray(0, total).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Portable state resume path must be a real directory");
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}
