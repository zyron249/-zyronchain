import { rm } from "node:fs/promises";

import type { PortableStateResumeStore } from "./state-v2-resume.js";
import { validatePortableResumeSnapshot } from "./state-v2-resume-trust.js";
import { ChainStore, type TrustedSnapshotAnchor, type TrustedSnapshotInstallFaultHooks } from "./storage.js";
import type { GenesisConfig } from "./types.js";

/**
 * Authenticate one complete resumable portable State-v2 store and publish it
 * through the canonical crash-safe trusted-snapshot installer without ever
 * materializing the legacy portable bundle.
 *
 * `stagingDir` is disposable validation scratch space owned by this call. It is
 * removed on both success and failure; the resume store remains untouched so a
 * transport retry/failover policy can decide whether to preserve or discard it.
 */
export async function installTrustedPortableResume(
  genesis: GenesisConfig,
  dataDir: string,
  store: PortableStateResumeStore,
  anchor: TrustedSnapshotAnchor,
  stagingDir: string,
  faultHooks: TrustedSnapshotInstallFaultHooks = {}
): Promise<ChainStore> {
  if (dataDir.length < 1) throw new Error("Portable state install data directory is required");
  if (stagingDir.length < 1) throw new Error("Portable state install staging directory is required");
  if (dataDir === stagingDir) throw new Error("Portable state install staging directory must differ from target");

  try {
    const trusted = await validatePortableResumeSnapshot(genesis, store, anchor, stagingDir);
    return await ChainStore.installTrustedSnapshot(genesis, dataDir, trusted.snapshot, anchor, faultHooks);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}
