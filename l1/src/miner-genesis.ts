import { readBoundedRegularControlFile } from "./control-file.js";

export const MINER_GENESIS_MAX_BYTES = 256 * 1024;
export const MAX_MINER_GENESIS_JSON_NESTING_DEPTH = 64;
export const MAX_MINER_GENESIS_JSON_STRUCTURAL_TOKENS = 100_000;

function assertBoundedMinerGenesisJsonStructure(text: string): void {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let tokens = 0;

  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (code === 0x5c) {
        escaped = true;
        continue;
      }
      if (code === 0x22) inString = false;
      continue;
    }

    if (code === 0x22) {
      inString = true;
      continue;
    }

    if (code === 0x7b || code === 0x5b) {
      depth += 1;
      tokens += 1;
      if (depth > MAX_MINER_GENESIS_JSON_NESTING_DEPTH) {
        throw new Error("Miner genesis JSON complexity exceeded");
      }
    } else if (code === 0x7d || code === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (code === 0x2c || code === 0x3a) {
      tokens += 1;
    }

    if (tokens > MAX_MINER_GENESIS_JSON_STRUCTURAL_TOKENS) {
      throw new Error("Miner genesis JSON complexity exceeded");
    }
  }
}

export async function readMinerGenesis(path: string): Promise<unknown> {
  const text = await readBoundedRegularControlFile(path, "Miner genesis file", MINER_GENESIS_MAX_BYTES);
  assertBoundedMinerGenesisJsonStructure(text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Miner genesis file contains invalid JSON");
  }
}
