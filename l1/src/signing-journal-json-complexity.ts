export const SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH = 16;
export const SIGNING_JOURNAL_MAX_JSON_STRUCTURAL_TOKENS = 128;

export function assertSigningJournalJsonComplexity(contents: string): void {
  let inString = false;
  let escaped = false;
  let depth = 0;
  let tokens = 0;

  for (let index = 0; index < contents.length; index += 1) {
    const code = contents.charCodeAt(index);
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
      if (depth > SIGNING_JOURNAL_MAX_JSON_NESTING_DEPTH) {
        throw new Error("Signing journal JSON complexity exceeded");
      }
    } else if (code === 0x7d || code === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (code === 0x2c || code === 0x3a) {
      tokens += 1;
    }
    if (tokens > SIGNING_JOURNAL_MAX_JSON_STRUCTURAL_TOKENS) {
      throw new Error("Signing journal JSON complexity exceeded");
    }
  }
}
