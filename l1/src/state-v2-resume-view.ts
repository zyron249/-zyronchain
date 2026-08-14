import { compareCanonicalStrings } from "./codec.js";
import { LedgerState, type LedgerSnapshot } from "./state.js";
import {
  stateV2FromLedgerSnapshot,
  type StateV2GovernanceSnapshot,
  type StateV2PortableView
} from "./state-v2.js";
import { parseStateV2PortableKeyPreimage } from "./state-v2-portable.js";
import { DEFAULT_PORTABLE_KEY_BATCH, streamPortableResumeKeys } from "./state-v2-resume-stream.js";
import type { CompletedPortableStateStage } from "./state-v2-resume-stage.js";
import type { PortableStateResumeStore } from "./state-v2-resume.js";
import type { Address, Validator } from "./types.js";

/**
 * Reconstruct the canonical ledger/governance view from an already authenticated
 * portable resume stage without materializing a full key-preimage array or a
 * second leaf-hash identity set in JavaScript memory.
 *
 * The completed stage is the trust boundary for exact root reachability and
 * semantic-key completeness. This function still replays every semantic key
 * against the staged root and reproduces the root from the canonical view, so a
 * mismatched store/stage pairing fails closed.
 */
export async function reconstructPortableResumeView(
  store: PortableStateResumeStore,
  staged: CompletedPortableStateStage,
  batchSize = DEFAULT_PORTABLE_KEY_BATCH
): Promise<StateV2PortableView> {
  if (!store.complete()) throw new Error("Portable state resume is incomplete");
  if (store.manifest.stateRoot !== staged.state.root()) throw new Error("Portable state view staging root mismatch");
  if (store.manifest.keyCount !== staged.importedKeyCount) throw new Error("Portable state view semantic-key count mismatch");

  const accounts: LedgerSnapshot["accounts"] = [];
  const epochs: number[] = [];
  const validatorSchedule: StateV2GovernanceSnapshot["validatorSchedule"] = [];
  const protocolSchedule: StateV2GovernanceSnapshot["protocolSchedule"] = [];
  let consumedKeys = 0;

  for await (const batch of streamPortableResumeKeys(store, batchSize)) {
    for (const rawKey of batch) {
      const key = parseStateV2PortableKeyPreimage(rawKey);
      consumedKeys += 1;
      const value = staged.state.get(key);
      if (value === undefined) throw new Error("Portable state semantic key has no committed value");

      if (key.startsWith("account:")) {
        const address = key.slice("account:".length) as Address;
        assertExactRecord(value, ["balanceAtoms", "nonce"], "State v2 account value");
        if (!Number.isSafeInteger(value.balanceAtoms) || Number(value.balanceAtoms) < 0 ||
            !Number.isSafeInteger(value.nonce) || Number(value.nonce) < 0) {
          throw new Error("Invalid State v2 account value");
        }
        accounts.push({ address, balanceAtoms: Number(value.balanceAtoms), nonce: Number(value.nonce) });
      } else if (key.startsWith("activity-epoch:")) {
        const epoch = parseSemanticHeight(key.slice("activity-epoch:".length), "activity epoch");
        assertExactRecord(value, ["settled"], "State v2 activity value");
        if (value.settled !== true) throw new Error("Invalid State v2 activity value");
        epochs.push(epoch);
      } else if (key.startsWith("validator-schedule:")) {
        const activationHeight = parseSemanticHeight(key.slice("validator-schedule:".length), "validator activation height");
        assertExactRecord(value, ["validators"], "State v2 validator schedule value");
        if (!Array.isArray(value.validators)) throw new Error("Invalid State v2 validator schedule value");
        validatorSchedule.push({ activationHeight, validators: structuredClone(value.validators) as Validator[] });
      } else if (key.startsWith("protocol-schedule:")) {
        const activationHeight = parseSemanticHeight(key.slice("protocol-schedule:".length), "protocol activation height");
        assertExactRecord(value, ["protocolVersion"], "State v2 protocol schedule value");
        if (!Number.isSafeInteger(value.protocolVersion) || Number(value.protocolVersion) < 1) {
          throw new Error("Invalid State v2 protocol schedule value");
        }
        protocolSchedule.push({ activationHeight, protocolVersion: Number(value.protocolVersion) });
      } else {
        throw new Error("Unknown State v2 semantic key");
      }
    }
  }

  if (consumedKeys !== staged.importedKeyCount) throw new Error("Portable state view semantic-key stream count mismatch");

  accounts.sort((a, b) => compareCanonicalStrings(a.address, b.address));
  epochs.sort((a, b) => a - b);
  validatorSchedule.sort((a, b) => a.activationHeight - b.activationHeight);
  protocolSchedule.sort((a, b) => a.activationHeight - b.activationHeight);
  assertUniqueNumbers(epochs, "activity epoch");
  assertUniqueNumbers(validatorSchedule.map((entry) => entry.activationHeight), "validator activation height");
  assertUniqueNumbers(protocolSchedule.map((entry) => entry.activationHeight), "protocol activation height");
  if (validatorSchedule[0]?.activationHeight !== 0 || protocolSchedule[0]?.activationHeight !== 0) {
    throw new Error("State v2 governance schedule must start at genesis");
  }

  const ledger = LedgerState.fromSnapshot({ accounts, settledActivityEpochs: epochs }).snapshot();
  const governance = { validatorSchedule, protocolSchedule };
  if (stateV2FromLedgerSnapshot(ledger, governance).root() !== staged.state.root()) {
    throw new Error("Reconstructed State v2 portable view root mismatch");
  }
  return { ledger, governance };
}

function parseSemanticHeight(value: string, name: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid State v2 ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Invalid State v2 ${name}`);
  return parsed;
}

function assertUniqueNumbers(values: readonly number[], name: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] === values[index - 1]) throw new Error(`Duplicate State v2 ${name}`);
  }
}

function assertExactRecord(value: unknown, keys: string[], name: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${name} fields`);
  }
}
