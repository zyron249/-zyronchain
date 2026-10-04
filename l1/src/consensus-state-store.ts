// Protocol v6 consensus-state files (spec §9.1): per-height QCs, the blocks a
// validator may have to re-propose or serve, the leader's pending proposal and
// the exact signed timeout vote of each round. Every write is atomic and
// durable (temporary file -> fsync -> rename -> fsync directory). Files for a
// height are deleted once that height is finalized (§9.3).
//
// Safety never depends on these files: the signing journal rows (storage.ts)
// are the anti-equivocation record. A missing or corrupt file only costs
// liveness (e.g. a lost QC file means the validator reports highQCRound = -1
// while its journal lock row keeps being enforced, §6.4).
import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { readBoundedFileBuffer } from "./bounded-file.js";

export const CONSENSUS_STATE_DIRECTORY = "consensus-state";
const MAX_CONSENSUS_STATE_FILE_BYTES = 3_000_000;
const NAME_PATTERN = /^H-(\d{1,16})(?:\.json|-B-[0-9a-f]{64}\.json|-r-\d{1,8}\.(?:proposal|timeout)\.json)$/;

export interface ConsensusStateFaultHooks {
  afterTemporarySync?: () => void | Promise<void>;
  afterRename?: () => void | Promise<void>;
}

function assertHeight(height: number): void {
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("Invalid consensus-state height");
}

function assertRound(round: number): void {
  if (!Number.isSafeInteger(round) || round < 0 || round > 99_999_999) throw new Error("Invalid consensus-state round");
}

function assertHash(hash: string): void {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid consensus-state hash");
}

export class ConsensusStateStore {
  readonly directory: string;
  private created = false;

  /** The directory is created lazily on the first write, so legacy (v1-v5) nodes never create it. */
  constructor(private readonly dataDir: string) {
    this.directory = join(dataDir, CONSENSUS_STATE_DIRECTORY);
  }

  private async ensureDirectory(): Promise<void> {
    if (this.created) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await syncDirectory(this.dataDir);
    this.created = true;
  }

  static heightFile(height: number): string { assertHeight(height); return `H-${height}.json`; }
  static blockFile(height: number, hash: string): string { assertHeight(height); assertHash(hash); return `H-${height}-B-${hash}.json`; }
  static proposalFile(height: number, round: number): string { assertHeight(height); assertRound(round); return `H-${height}-r-${round}.proposal.json`; }
  static timeoutFile(height: number, round: number): string { assertHeight(height); assertRound(round); return `H-${height}-r-${round}.timeout.json`; }

  async write(name: string, value: unknown, faultHooks: ConsensusStateFaultHooks = {}): Promise<void> {
    if (!NAME_PATTERN.test(name)) throw new Error("Invalid consensus-state file name");
    const contents = JSON.stringify(value);
    if (Buffer.byteLength(contents, "utf8") > MAX_CONSENSUS_STATE_FILE_BYTES) throw new Error("Consensus-state file exceeds byte limit");
    await this.ensureDirectory();
    const target = join(this.directory, name);
    const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(contents, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await faultHooks.afterTemporarySync?.();
      await rename(temporary, target);
      renamed = true;
      await faultHooks.afterRename?.();
      await syncDirectory(this.directory);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  /** Parsed JSON, or undefined when the file is missing or unreadable (callers treat both as absent). */
  async read(name: string): Promise<unknown> {
    if (!NAME_PATTERN.test(name)) throw new Error("Invalid consensus-state file name");
    try {
      const bytes = await readBoundedFileBuffer(join(this.directory, name), MAX_CONSENSUS_STATE_FILE_BYTES, "Consensus-state file");
      return JSON.parse(bytes.toString("utf8")) as unknown;
    } catch {
      return undefined;
    }
  }

  async remove(name: string): Promise<void> {
    if (!NAME_PATTERN.test(name)) throw new Error("Invalid consensus-state file name");
    await rm(join(this.directory, name), { force: true });
  }

  /** Delete every file of heights <= finalizedHeight (and stray temporaries). Returns the number removed. */
  async pruneThrough(finalizedHeight: number): Promise<number> {
    let removed = 0;
    let entries: string[];
    try {
      entries = await readdir(this.directory);
    } catch {
      return 0;
    }
    for (const name of entries) {
      const match = /^H-(\d{1,16})[-.]/.exec(name);
      const height = match ? Number(match[1]) : Number.NaN;
      if (Number.isSafeInteger(height) && height <= finalizedHeight) {
        await rm(join(this.directory, name), { force: true });
        removed += 1;
      }
    }
    if (removed > 0) await syncDirectory(this.directory);
    return removed;
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.directory)).filter((name) => NAME_PATTERN.test(name)).sort();
    } catch {
      return [];
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
