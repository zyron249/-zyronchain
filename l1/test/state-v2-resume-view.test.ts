import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { compareCanonicalStrings } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import {
  stateV2FromLedgerSnapshot,
  stateV2KeyPreimages,
  type StateV2GovernanceSnapshot,
  type StateV2NodeRecord
} from "../src/state-v2.js";
import {
  stagePortableResumeRecords,
  stagePortableResumeSemanticKeys
} from "../src/state-v2-resume-stage.js";
import { reconstructPortableResumeView } from "../src/state-v2-resume-view.js";
import type { PortableStateResumeStore } from "../src/state-v2-resume.js";

function fakeStore(
  root: string,
  records: readonly StateV2NodeRecord[],
  keys: readonly string[]
): PortableStateResumeStore {
  return {
    manifest: { stateRoot: root, recordCount: records.length, keyCount: keys.length },
    complete: () => true,
    records: async (start: number, limit: number) => structuredClone(records.slice(start, start + limit)),
    keys: async (start: number, limit: number) => [...keys.slice(start, start + limit)]
  } as unknown as PortableStateResumeStore;
}

async function withTempDir(run: (path: string) => Promise<void>): Promise<void> {
  const path = await mkdtemp(join(tmpdir(), "zyron-state-view-"));
  try { await run(path); }
  finally { await rm(path, { recursive: true, force: true }); }
}

function governanceFixture(): StateV2GovernanceSnapshot {
  const validatorPublicKey = publicKeyFromPrivate("31".padStart(64, "0"));
  return {
    validatorSchedule: [{
      activationHeight: 0,
      validators: [{ address: addressFromPublicKey(validatorPublicKey), publicKey: validatorPublicKey }]
    }],
    protocolSchedule: [
      { activationHeight: 0, protocolVersion: 1 },
      { activationHeight: 100, protocolVersion: 2 }
    ]
  };
}

test("portable resume view reconstructs canonical ledger and governance through bounded key batches", async () => {
  const accounts = Array.from({ length: 25 }, (_, index) => {
    const publicKey = publicKeyFromPrivate(String(index + 50).padStart(64, "0"));
    return {
      address: addressFromPublicKey(publicKey),
      balanceAtoms: index + 1,
      nonce: index
    };
  }).sort((a, b) => compareCanonicalStrings(a.address, b.address));
  const ledger = { accounts, settledActivityEpochs: [3, 9] };
  const governance = governanceFixture();
  const state = stateV2FromLedgerSnapshot(ledger, governance);
  const keys = stateV2KeyPreimages(ledger, governance);
  const store = fakeStore(state.root(), state.nodeRecords(), keys);

  await withTempDir(async (path) => {
    const records = await stagePortableResumeRecords(store, path, 7);
    const completed = await stagePortableResumeSemanticKeys(store, records, 5);
    try {
      const view = await reconstructPortableResumeView(store, completed, 4);
      assert.deepEqual(view.ledger, ledger);
      assert.deepEqual(view.governance, governance);
      assert.equal(stateV2FromLedgerSnapshot(view.ledger, view.governance).root(), state.root());
    } finally {
      completed.nodeObjects.close();
    }
  });
});

test("portable resume view rejects a store/stage semantic-count mismatch before reconstruction", async () => {
  const ledger = { accounts: [], settledActivityEpochs: [] };
  const governance = governanceFixture();
  const state = stateV2FromLedgerSnapshot(ledger, governance);
  const keys = stateV2KeyPreimages(ledger, governance);
  const store = fakeStore(state.root(), state.nodeRecords(), keys);

  await withTempDir(async (path) => {
    const records = await stagePortableResumeRecords(store, path, 3);
    const completed = await stagePortableResumeSemanticKeys(store, records, 2);
    try {
      const mismatched = fakeStore(state.root(), state.nodeRecords(), [...keys, "account:extra"]);
      await assert.rejects(
        () => reconstructPortableResumeView(mismatched, completed, 2),
        /semantic-key count mismatch/
      );
    } finally {
      completed.nodeObjects.close();
    }
  });
});
