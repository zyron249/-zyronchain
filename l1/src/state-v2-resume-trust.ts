import { ZyronChain, type ChainSnapshotV1 } from "./chain.js";
import {
  stagePortableResumeRecords,
  stagePortableResumeSemanticKeys,
  type CompletedPortableStateStage
} from "./state-v2-resume-stage.js";
import { reconstructPortableResumeView } from "./state-v2-resume-view.js";
import type { PortableStateResumeStore } from "./state-v2-resume.js";
import type { TrustedSnapshotAnchor } from "./storage.js";
import type { GenesisConfig } from "./types.js";

export interface TrustedPortableResumeSnapshot {
  snapshot: ChainSnapshotV1;
  stateRoot: string;
}

/**
 * Crosses the portable-resume trust boundary without rebuilding a raw portable
 * bundle. Records and semantic-key preimages stay in the bounded SQLite-backed
 * stage; the canonical ledger/governance snapshot is reconstructed from that
 * authenticated root and then passed through the existing finalized snapshot
 * verifier under the original external tip/digest anchor.
 */
export async function validatePortableResumeSnapshot(
  genesis: GenesisConfig,
  store: PortableStateResumeStore,
  anchor: TrustedSnapshotAnchor,
  stagingDir: string
): Promise<TrustedPortableResumeSnapshot> {
  if (stagingDir.length < 1) throw new Error("Portable state trust staging directory is required");
  if (!store.complete()) throw new Error("Portable state resume is incomplete");
  const expected = new ZyronChain(genesis);
  const manifest = store.manifest;
  if (manifest.chainId !== genesis.chainId || manifest.genesisHash !== expected.genesisHash ||
      manifest.tipHash !== anchor.tipHash || manifest.snapshotSha256 !== anchor.snapshotSha256) {
    throw new Error("Portable state resume external anchor identity mismatch");
  }
  if (manifest.tip.hash !== manifest.tipHash || manifest.tip.header.height !== manifest.height ||
      manifest.tip.header.stateRoot !== manifest.stateRoot) {
    throw new Error("Portable state resume manifest tip mismatch");
  }

  const records = await stagePortableResumeRecords(store, stagingDir);
  let completed: CompletedPortableStateStage | undefined;
  try {
    completed = await stagePortableResumeSemanticKeys(store, records);
    const view = await reconstructPortableResumeView(store, completed);
    const snapshot: ChainSnapshotV1 = {
      version: 1,
      chainId: manifest.chainId,
      genesisHash: manifest.genesisHash,
      height: manifest.height,
      tip: structuredClone(manifest.tip),
      state: view.ledger,
      validatorSchedule: view.governance.validatorSchedule,
      protocolSchedule: view.governance.protocolSchedule
    };

    // Reuse the canonical checkpoint validator for full-snapshot digest,
    // proposer/finality certificates, governance schedules and State-v2 root.
    const chain = ZyronChain.fromTrustedSnapshot(genesis, snapshot, anchor);
    if (chain.height !== manifest.height || chain.tip.hash !== manifest.tipHash ||
        chain.tip.header.stateRoot !== manifest.stateRoot) {
      throw new Error("Portable state resume anchored snapshot validation mismatch");
    }
    return { snapshot, stateRoot: manifest.stateRoot };
  } finally {
    // stagePortableResumeSemanticKeys closes the record stage itself on failure;
    // once it succeeds, this function owns and closes the completed stage.
    completed?.nodeObjects.close();
  }
}
