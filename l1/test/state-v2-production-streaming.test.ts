import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const source = (name: string) => readFile(resolve(process.cwd(), "src", name), "utf8");

describe("production State-v2 resumable install wiring", () => {
  it("routes the supported secure CLI state-fetch-install command away from legacy bundle materialization", async () => {
    const secureCli = await source("secure-cli.ts");
    assert.match(secureCli, /command === "state-fetch-install"/);
    assert.match(secureCli, /runStateFetchInstall\(args\.slice\(1\)\)/);
  });

  it("keeps the bounded production fetch path free of full portable bundle assembly", async () => {
    const fetcher = await source("state-v2-resume-fetch.ts");
    assert.doesNotMatch(fetcher, /\.bundle\s*\(/);
    assert.doesNotMatch(fetcher, /structuredClone\s*\(\s*bundle\s*\)/);
    assert.match(fetcher, /validatePortableResumeSnapshot/);
    assert.match(fetcher, /await resume\.discard\(\)/);
    assert.match(fetcher, /PortableStateResumeAssemblyError/);
  });

  it("installs only through the authenticated resume-store boundary and removes resume bytes only after success", async () => {
    const command = await source("state-v2-fetch-install-command.ts");
    assert.match(command, /fetchTrustedPortableResumeFromAnyPeer/);
    assert.match(command, /installTrustedPortableResume/);
    const installAt = command.indexOf("installTrustedPortableResume");
    const removeAt = command.indexOf("await rm(resumeDir");
    assert.ok(installAt >= 0 && removeAt > installAt, "resume store must survive until authenticated install succeeds");
    assert.doesNotMatch(command, /installTrustedPortableState/);
  });
});
