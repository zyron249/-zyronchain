import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createRoundSkipVote } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import type { Block, GenesisConfig } from "../src/types.js";

export interface AdversarialHarnessOptions {
  steps: number;
  seed: number;
}

export interface AdversarialHarnessReport {
  schemaVersion: 1;
  seed: number;
  requestedSteps: number;
  finalizedHeight: number;
  finalTipHash: string;
  finalStateRoot: string;
  faultEvents: {
    quorumLossStalls: number;
    proposerFailures: number;
    isolatedDeliveries: number;
    crashReplays: number;
    equivocationRejections: number;
  };
  invariants: {
    conflictingFinalityObserved: false;
    allNodesConverged: true;
    replayConverged: true;
  };
}

const validatorPrivates = ["31", "32", "33", "34"].map((value) => value.padStart(64, "0"));
const validatorPublics = validatorPrivates.map(publicKeyFromPrivate);
const genesis = createGenesis();

export function runAdversarialHarness(options: AdversarialHarnessOptions): AdversarialHarnessReport {
  if (!Number.isSafeInteger(options.steps) || options.steps < 1 || options.steps > 1_000_000) {
    throw new Error("Adversarial harness steps must be an integer between 1 and 1000000");
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 1 || options.seed > 0xffff_ffff) {
    throw new Error("Adversarial harness seed must be an integer between 1 and 4294967295");
  }

  const random = xorshift32(options.seed);
  const nodes = Array.from({ length: 4 }, () => new ZyronChain(genesis));
  const finalized: Block[] = [];
  let quorumLossStalls = 0;
  let proposerFailures = 0;
  let isolatedDeliveries = 0;
  let crashReplays = 0;
  let equivocationRejections = 0;
  let replayConverged = true;

  for (let height = 1; height <= options.steps; height += 1) {
    for (let index = 0; index < nodes.length; index += 1) {
      catchUp(nodes[index]!, finalized);
    }

    const producer = nodes[0]!;
    const baseTimestamp = genesis.timestampMs + (height * 1_000);
    const scheduledProposerFailure = height % 7 === 0;
    const round = scheduledProposerFailure ? 1 : 0;
    const roundCertificate = round === 0 ? [] : [0, 1, 2].map((index) => createRoundSkipVote({
      chainId: genesis.chainId,
      height,
      round: 0,
      previousHash: producer.tip.hash,
      validatorPrivateKey: validatorPrivates[index]!,
      validatorPublicKey: validatorPublics[index]!
    }));
    if (scheduledProposerFailure) proposerFailures += 1;

    const proposerIndex = (height - 1 + round) % validatorPrivates.length;
    let candidate = producer.produceBlock([], validatorPrivates[proposerIndex]!, {
      round,
      roundCertificate,
      timestampMs: baseTimestamp
    });

    if (height % 11 === 0) {
      let minority = candidate;
      for (const index of [0, 1]) minority = producer.attestBlock(minority, validatorPrivates[index]!);
      assertRejected(() => nodes[1]!.acceptBlock(minority, baseTimestamp), "minority partition finalized a block");
      quorumLossStalls += 1;
    }

    if (height % 19 === 0) {
      let conflicting = producer.produceBlock([], validatorPrivates[proposerIndex]!, {
        round,
        roundCertificate,
        timestampMs: baseTimestamp + 1
      });
      const signers = random() % 2 === 0 ? [0, 1] : [2, 3];
      for (const index of signers) conflicting = producer.attestBlock(conflicting, validatorPrivates[index]!);
      assertRejected(() => nodes[2]!.acceptBlock(conflicting, baseTimestamp + 1), "minority equivocation reached finality");
      equivocationRejections += 1;
    }

    for (const index of [0, 1, 2]) candidate = producer.attestBlock(candidate, validatorPrivates[index]!);
    const isolatedIndex = height % 17 === 0 ? Number(random() % 3) + 1 : -1;
    for (let index = 0; index < nodes.length; index += 1) {
      if (index === isolatedIndex) continue;
      nodes[index]!.acceptBlock(candidate, baseTimestamp + 1);
    }
    if (isolatedIndex >= 0) isolatedDeliveries += 1;
    finalized.push(candidate);

    if (height % 13 === 0) {
      const restartIndex = Number(random() % nodes.length);
      const replayed = new ZyronChain(genesis);
      catchUp(replayed, finalized);
      replayConverged &&= replayed.tip.hash === candidate.hash &&
        replayed.getState().root() === producer.getState().root();
      nodes[restartIndex] = replayed;
      crashReplays += 1;
    }
  }

  for (const node of nodes) catchUp(node, finalized);
  const reference = nodes[0]!;
  const allNodesConverged = nodes.every((node) =>
    node.height === reference.height &&
    node.tip.hash === reference.tip.hash &&
    node.getState().root() === reference.getState().root()
  );
  if (!allNodesConverged || !replayConverged) throw new Error("Adversarial harness convergence invariant failed");

  return {
    schemaVersion: 1,
    seed: options.seed,
    requestedSteps: options.steps,
    finalizedHeight: reference.height,
    finalTipHash: reference.tip.hash,
    finalStateRoot: reference.getState().root(),
    faultEvents: {
      quorumLossStalls,
      proposerFailures,
      isolatedDeliveries,
      crashReplays,
      equivocationRejections
    },
    invariants: {
      conflictingFinalityObserved: false,
      allNodesConverged: true,
      replayConverged: true
    }
  };
}

function catchUp(node: ZyronChain, finalized: readonly Block[]): void {
  for (let index = node.height; index < finalized.length; index += 1) {
    const block = finalized[index]!;
    node.acceptBlock(block, block.header.timestampMs + 1);
  }
}

function assertRejected(operation: () => void, message: string): void {
  try {
    operation();
  } catch {
    return;
  }
  throw new Error(message);
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function createGenesis(): GenesisConfig {
  const activityPool = addressFromPublicKey(publicKeyFromPrivate("35".padStart(64, "0")));
  return {
    chainId: "zyron-adversarial-harness-1",
    timestampMs: 1_700_000_000_000,
    validators: validatorPublics.map((publicKey) => ({
      address: addressFromPublicKey(publicKey),
      publicKey
    })),
    activityOracles: [publicKeyFromPrivate("36".padStart(64, "0"))],
    activityPool,
    allocations: [{ address: activityPool, amountAtoms: 1_000_000 }]
  };
}

function parsePositiveInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`Invalid ${name}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name}`);
  return parsed;
}

async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name || !value || !["--steps", "--seed", "--report"].includes(name)) {
      throw new Error("Usage: adversarial-multinode --steps <n> --seed <n> --report <path>");
    }
    args.set(name, value);
  }
  const reportPath = resolve(args.get("--report") ?? "artifacts/adversarial-multinode.json");
  const report = runAdversarialHarness({
    steps: parsePositiveInteger(args.get("--steps"), "steps", 10_000),
    seed: parsePositiveInteger(args.get("--seed"), "seed", 0x5a17_2026)
  });
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  console.log(`Adversarial evidence written: ${reportPath}`);
  console.log(`Finalized ${report.finalizedHeight} blocks with seed ${report.seed}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Adversarial harness failed");
    process.exitCode = 1;
  });
}
