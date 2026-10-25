// Build commit for GET /readyz (Red Team S1 retest INFO: the gateway exposed
// no commit, so the deployed revision had to be inferred). Only a value that
// looks like a git commit SHA is ever returned, so a misconfigured variable
// cannot leak a secret through a public endpoint.
export const BUILD_COMMIT_ENV_VARS = ["ZYRON_BUILD_COMMIT", "RENDER_GIT_COMMIT", "SOURCE_VERSION", "GIT_COMMIT"] as const;

const COMMIT_SHA = /^[0-9a-f]{7,64}$/;

export function buildCommit(env: Record<string, string | undefined> = process.env): string {
  for (const name of BUILD_COMMIT_ENV_VARS) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    return COMMIT_SHA.test(value) ? value : "unknown";
  }
  return "unknown";
}
