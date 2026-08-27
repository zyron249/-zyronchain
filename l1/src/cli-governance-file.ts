import { readBoundedUtf8File } from "./bounded-file.js";

export const CLI_GOVERNANCE_ARTIFACT_MAX_BYTES = 1024 * 1024;
const CLI_GOVERNANCE_MAX_JSON_NESTING_DEPTH = 64;
const CLI_GOVERNANCE_MAX_JSON_STRUCTURAL_TOKENS = 100_000;

export async function readCliGovernanceArtifactUtf8(path: string): Promise<string> {
  const contents = await readBoundedUtf8File(path, CLI_GOVERNANCE_ARTIFACT_MAX_BYTES, "CLI governance artifact");
  assertCliGovernanceJsonComplexity(contents);
  return contents;
}

function assertCliGovernanceJsonComplexity(contents: string): void {
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
      if (depth > CLI_GOVERNANCE_MAX_JSON_NESTING_DEPTH) {
        throw new Error("CLI governance artifact JSON complexity exceeded");
      }
    } else if (code === 0x7d || code === 0x5d) {
      depth = Math.max(0, depth - 1);
      tokens += 1;
    } else if (code === 0x2c || code === 0x3a) {
      tokens += 1;
    }
    if (tokens > CLI_GOVERNANCE_MAX_JSON_STRUCTURAL_TOKENS) {
      throw new Error("CLI governance artifact JSON complexity exceeded");
    }
  }
}
