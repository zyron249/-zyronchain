import { readBoundedRegularControlFile } from "./control-file.js";

export const MINER_GENESIS_MAX_BYTES = 256 * 1024;

export async function readMinerGenesis(path: string): Promise<unknown> {
  const text = await readBoundedRegularControlFile(path, "Miner genesis file", MINER_GENESIS_MAX_BYTES);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Miner genesis file contains invalid JSON");
  }
}
