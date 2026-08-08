import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import { canonicalJson } from "./codec.js";
import { ZyronChain } from "./chain.js";
import type { Block, GenesisConfig } from "./types.js";

const STORE_VERSION = 1;
const MAX_STORED_BLOCK_LINE_BYTES = 2_500_000;
const MAX_SIGNING_LINE_BYTES = 1_024;

interface StoreMetadata {
  version: number;
  chainId: string;
  genesisHash: string;
}

export class ChainStore {
  private persistedHeight: number;

  private constructor(
    readonly dataDir: string,
    readonly chain: ZyronChain,
    persistedHeight: number
  ) {
    this.persistedHeight = persistedHeight;
  }

  static async open(genesis: GenesisConfig, dataDir: string): Promise<ChainStore> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const chain = new ZyronChain(genesis);
    const metadataPath = join(dataDir, "metadata.json");
    const expected: StoreMetadata = {
      version: STORE_VERSION,
      chainId: genesis.chainId,
      genesisHash: chain.tip.hash
    };
    await ensureMetadata(metadataPath, expected);

    const blocksPath = join(dataDir, "blocks.ndjson");
    let count = 0;
    try {
      for await (const line of readLines(blocksPath)) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_STORED_BLOCK_LINE_BYTES) {
          throw new Error("Stored block exceeds line limit");
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          throw new Error(`Corrupt stored block at line ${count + 1}`);
        }
        chain.acceptBlock(parsed as Block, Number.MAX_SAFE_INTEGER);
        count += 1;
        if (chain.height !== count) throw new Error("Stored block height discontinuity");
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await writeFile(blocksPath, "", { flag: "wx", mode: 0o600 });
    }
    return new ChainStore(dataDir, chain, count);
  }

  async commitFinalizedBlock(block: Block, nowMs = Date.now()): Promise<void> {
    if (block.header.height !== this.persistedHeight + 1) {
      throw new Error("Refusing non-sequential block persistence");
    }
    if (this.chain.height !== this.persistedHeight) {
      throw new Error("In-memory chain and durable height diverged");
    }
    // Validate against the current durable tip before writing. The fsync deliberately
    // happens before mutating in-memory state: a crash after fsync is recovered by
    // replay, while a failed disk write cannot make the live node advertise a tip that
    // was never durably committed.
    this.chain.validateFinalizedBlock(block, nowMs);
    const line = `${canonicalJson(block)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_STORED_BLOCK_LINE_BYTES) {
      throw new Error("Block exceeds persistence limit");
    }
    const handle = await open(join(this.dataDir, "blocks.ndjson"), "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.chain.acceptBlock(block, nowMs);
    this.persistedHeight = block.header.height;
  }
}

export class SigningJournal {
  private readonly reservations = new Map<string, string>();
  private constructor(readonly path: string) {}

  static async open(dataDir: string): Promise<SigningJournal> {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const journal = new SigningJournal(join(dataDir, "signing-journal.ndjson"));
    try {
      for await (const line of readLines(journal.path)) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line, "utf8") > MAX_SIGNING_LINE_BYTES) throw new Error("Corrupt signing journal");
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (!Number.isSafeInteger(parsed.height) || !Number.isSafeInteger(parsed.round) ||
            (parsed.kind !== "attest" && parsed.kind !== "skip") ||
            typeof parsed.value !== "string" || !/^[0-9a-f]{64}$/.test(parsed.value)) {
          throw new Error("Corrupt signing journal entry");
        }
        const key = `${parsed.height}:${parsed.round}`;
        const reservation = `${parsed.kind}:${parsed.value}`;
        const previous = journal.reservations.get(key);
        if (previous && previous !== reservation) throw new Error("Conflicting signing journal history");
        journal.reservations.set(key, reservation);
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      await writeFile(journal.path, "", { flag: "wx", mode: 0o600 });
    }
    return journal;
  }

  async reserveAttestation(height: number, round: number, blockHash: string): Promise<void> {
    return this.reserveChoice(height, round, "attest", blockHash);
  }

  async reserveSkip(height: number, round: number, previousHash: string): Promise<void> {
    return this.reserveChoice(height, round, "skip", previousHash);
  }

  private async reserveChoice(height: number, round: number, kind: "attest" | "skip", value: string): Promise<void> {
    if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0) {
      throw new Error("Invalid signing slot");
    }
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Invalid signing hash");
    const key = `${height}:${round}`;
    const reservation = `${kind}:${value}`;
    const existing = this.reservations.get(key);
    if (existing === reservation) return;
    if (existing) throw new Error("Conflicting validator action prevented for consensus round");

    const line = `${JSON.stringify({ height, round, kind, value })}\n`;
    const handle = await open(this.path, "a", 0o600);
    try {
      await handle.writeFile(line, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.reservations.set(key, reservation);
  }
}

async function ensureMetadata(path: string, expected: StoreMetadata): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(path, "utf8")) as Partial<StoreMetadata>;
    if (existing.version !== expected.version || existing.chainId !== expected.chainId ||
        existing.genesisHash !== expected.genesisHash) {
      throw new Error("Data directory belongs to a different or unsupported chain");
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(expected)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  }
}

async function* readLines(path: string): AsyncGenerator<string> {
  const input = createReadStream(path, { encoding: "utf8" });
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of reader) yield line;
  } finally {
    reader.close();
    input.destroy();
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT");
}
