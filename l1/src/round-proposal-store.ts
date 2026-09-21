import { randomBytes } from "node:crypto";
import { mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";

import { readBoundedUtf8File } from "./bounded-file.js";
import { MAX_BLOCK_BYTES, validateBlockShape } from "./block.js";
import { canonicalJson } from "./codec.js";
import type { Block } from "./types.js";

/**
 * Durable copy of a proposal a validator is about to attest.
 *
 * The signing journal records only the hash. Recovery from an attest/skip
 * split needs the header preimage, so the unsigned proposal is stored before
 * the journal reservation and replaced with the signed proposal after signing.
 */
export class RoundProposalStore {
  constructor(private readonly directory: string) {}

  async load(height: number, round: number): Promise<Block | undefined> {
    assertSlot(height, round);
    let text: string;
    try {
      text = await readBoundedUtf8File(this.path(height, round), MAX_BLOCK_BYTES, "round proposal");
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw new Error("Round proposal store is corrupt; validator restart required", { cause: error });
    }
    try {
      const parsed = JSON.parse(text) as unknown;
      validateBlockShape(parsed);
      if (parsed.header.height !== height || parsed.header.round !== round) {
        throw new Error("Round proposal slot mismatch");
      }
      return parsed;
    } catch (error) {
      throw new Error("Round proposal store is corrupt; validator restart required", { cause: error });
    }
  }

  async save(block: Block): Promise<void> {
    validateBlockShape(block);
    const height = block.header.height;
    const round = block.header.round;
    assertSlot(height, round);
    const existing = await this.load(height, round);
    if (existing) {
      if (existing.hash !== block.hash) throw new Error("Conflicting round proposal");
      if (existing.signature && block.signature === existing.signature) return;
      if (existing.signature && block.signature && existing.signature !== block.signature) {
        throw new Error("Conflicting round proposal");
      }
      if (!block.signature) return;
    }
    const body = canonicalJson(block);
    if (Buffer.byteLength(body, "utf8") > MAX_BLOCK_BYTES) throw new Error("Round proposal exceeds byte limit");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = this.path(height, round);
    const temporary = `${path}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
    let renamed = false;
    try {
      const handle = await open(temporary, "wx", 0o600);
      try {
        await handle.writeFile(body, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, path);
      renamed = true;
      await syncDirectory(this.directory);
    } finally {
      if (!renamed) await rm(temporary, { force: true });
    }
  }

  async discardThrough(finalizedHeight: number): Promise<void> {
    if (!Number.isSafeInteger(finalizedHeight) || finalizedHeight < 0) return;
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if (isMissing(error)) return;
      return;
    }
    await Promise.all(names.map(async (name) => {
      const match = /^(\d+)-(\d+)\.json$/.exec(name);
      if (!match) return;
      const height = Number(match[1]);
      if (height <= finalizedHeight) await rm(join(this.directory, name), { force: true });
    }));
  }

  private path(height: number, round: number): string {
    return join(this.directory, `${height}-${round}.json`);
  }
}

function assertSlot(height: number, round: number): void {
  if (!Number.isSafeInteger(height) || height < 1 || !Number.isSafeInteger(round) || round < 0) {
    throw new Error("Invalid round proposal slot");
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "ENOENT";
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
