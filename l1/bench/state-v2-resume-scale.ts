import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createStateV2PortableBundle } from "../src/state-v2-portable.js";
import { PortableStateResumeStore } from "../src/state-v2-resume.js";
import { stagePortableResumeRecords, stagePortableResumeSemanticKeys } from "../src/state-v2-resume-stage.js";
import { stateV2FromLedgerSnapshot } from "../src/state-v2.js";
import type { LedgerSnapshot } from "../src/state.js";
import type { StateV2GovernanceSnapshot } from "../src/state-v2.js";
import type { Address, Block } from "../src/types.js";

const worker = process.argv[2];
if (worker === "prepare") {
  await prepare(process.argv[3]!, parsePositiveInteger(process.argv[4]!, "account count"));
} else if (worker === "stage") {
  await stage(process.argv[3]!, process.argv[4]!);
} else {
  await benchmark();
}

async function benchmark(): Promise<void> {
  const accounts = parsePositiveInteger(
    process.env.ZYRON_RESUME_SCALE_ACCOUNTS ?? "10000",
    "ZYRON_RESUME_SCALE_ACCOUNTS"
  );
  const directory = await mkdtemp(join(tmpdir(), "zyron-state-v2-resume-scale-"));
  const resumeDir = join(directory, "resume");
  const stagingDir = join(directory, "stage");
  const self = fileURLToPath(import.meta.url);
  try {
    const prepared = runWorker(self, ["prepare", resumeDir, String(accounts)]) as PrepareResult;
    const staged = runWorker(self, ["stage", resumeDir, stagingDir]) as StageResult;
    if (staged.root !== prepared.root) throw new Error("Resume scale staging changed the authenticated State v2 root");
    if (staged.records !== prepared.records || staged.keys !== prepared.keys) {
      throw new Error("Resume scale staging changed portable object counts");
    }
    console.log(JSON.stringify({ accounts, prepared, staged }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function prepare(resumeDir: string, accounts: number): Promise<void> {
  const started = performance.now();
  const ledger: LedgerSnapshot = {
    accounts: Array.from({ length: accounts }, (_, index) => ({
      address: scaleAddress(index),
      balanceAtoms: 1,
      nonce: 0
    })),
    settledActivityEpochs: []
  };
  const governance: StateV2GovernanceSnapshot = {
    validatorSchedule: [{ activationHeight: 0, validators: [] }],
    protocolSchedule: [{ activationHeight: 0, protocolVersion: 2 }]
  };
  const state = stateV2FromLedgerSnapshot(ledger, governance);
  const bundle = createStateV2PortableBundle(state, ledger, governance);
  const manifest = {
    version: 1 as const,
    chainId: "zyron-resume-scale-1",
    genesisHash: "11".repeat(32),
    tipHash: "22".repeat(32),
    snapshotSha256: "33".repeat(32),
    height: 1,
    stateRoot: bundle.root,
    recordCount: bundle.records.length,
    keyCount: bundle.keyPreimages.length,
    tip: {} as Block
  };
  const resume = await PortableStateResumeStore.open(resumeDir, manifest);
  for (let start = 0; start < bundle.records.length; start += 128) {
    await resume.putRecords(start, bundle.records.slice(start, start + 128));
  }
  for (let start = 0; start < bundle.keyPreimages.length; start += 1_024) {
    await resume.putKeys(start, bundle.keyPreimages.slice(start, start + 1_024));
  }
  if (!resume.complete()) throw new Error("Resume scale fixture did not complete");
  console.log(JSON.stringify({
    root: bundle.root,
    records: bundle.records.length,
    keys: bundle.keyPreimages.length,
    prepareMs: rounded(performance.now() - started)
  } satisfies PrepareResult));
}

async function stage(resumeDir: string, stagingDir: string): Promise<void> {
  const resume = await PortableStateResumeStore.openExisting(resumeDir, {
    chainId: "zyron-resume-scale-1",
    genesisHash: "11".repeat(32),
    tipHash: "22".repeat(32),
    snapshotSha256: "33".repeat(32)
  });
  const before = process.memoryUsage();
  const started = performance.now();
  const records = await stagePortableResumeRecords(resume, stagingDir);
  const completed = await stagePortableResumeSemanticKeys(resume, records);
  const after = process.memoryUsage();
  const maxRssKiB = process.resourceUsage().maxRSS;
  const result: StageResult = {
    root: completed.state.root(),
    records: completed.importedRecordCount,
    keys: completed.importedKeyCount,
    stageMs: rounded(performance.now() - started),
    heapDeltaMiB: rounded((after.heapUsed - before.heapUsed) / (1024 * 1024)),
    rssMiB: rounded(after.rss / (1024 * 1024)),
    maxRssMiB: rounded(maxRssKiB / 1024)
  };
  completed.nodeObjects.close();
  console.log(JSON.stringify(result));
}

function runWorker(self: string, args: string[]): unknown {
  return JSON.parse(execFileSync(process.execPath, [self, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024
  }).trim()) as unknown;
}

function scaleAddress(index: number): Address {
  return `ZYN${index.toString(16).padStart(40, "0")}`;
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${label} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 250_000) throw new Error(`${label} is too large`);
  return parsed;
}

function rounded(value: number): number { return Number(value.toFixed(2)); }

interface PrepareResult {
  root: string;
  records: number;
  keys: number;
  prepareMs: number;
}

interface StageResult {
  root: string;
  records: number;
  keys: number;
  stageMs: number;
  heapDeltaMiB: number;
  rssMiB: number;
  maxRssMiB: number;
}
