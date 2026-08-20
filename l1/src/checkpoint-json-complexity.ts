export const MAX_CHECKPOINT_JSON_NESTING_DEPTH = 64;
export const MAX_CHECKPOINT_JSON_STRUCTURAL_TOKENS = 250_000;

/**
 * Bounds JSON object-graph amplification before JSON.parse allocates the graph.
 * The input must already be byte-bounded by the checkpoint transport limit.
 */
export function assertBoundedCheckpointJsonStructure(body: Uint8Array): void {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let tokens = 0;

  for (const byte of body) {
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (byte === 0x5c) {
        escaped = true;
        continue;
      }
      if (byte === 0x22) inString = false;
      continue;
    }

    if (byte === 0x22) {
      inString = true;
      continue;
    }

    if (byte === 0x7b || byte === 0x5b) {
      depth += 1;
      tokens += 1;
      if (depth > MAX_CHECKPOINT_JSON_NESTING_DEPTH) {
        throw new Error("Checkpoint JSON complexity exceeded");
      }
    } else if (byte === 0x7d || byte === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (byte === 0x2c || byte === 0x3a) {
      tokens += 1;
    }

    if (tokens > MAX_CHECKPOINT_JSON_STRUCTURAL_TOKENS) {
      throw new Error("Checkpoint JSON complexity exceeded");
    }
  }
}
