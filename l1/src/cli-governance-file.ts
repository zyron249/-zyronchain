import { readBoundedUtf8File } from "./bounded-file.js";

export const CLI_GOVERNANCE_ARTIFACT_MAX_BYTES = 1024 * 1024;

export function readCliGovernanceArtifactUtf8(path: string): Promise<string> {
  return readBoundedUtf8File(path, CLI_GOVERNANCE_ARTIFACT_MAX_BYTES, "CLI governance artifact");
}
