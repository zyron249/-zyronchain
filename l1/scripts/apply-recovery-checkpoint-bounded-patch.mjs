#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';

function replaceOnce(source, from, to, label) {
  const first = source.indexOf(from);
  if (first < 0) throw new Error(`missing ${label}`);
  if (source.indexOf(from, first + from.length) >= 0) throw new Error(`duplicate ${label}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

const storagePath = 'l1/src/storage.ts';
let storage = await readFile(storagePath, 'utf8');
storage = replaceOnce(
  storage,
  'import { readRegularUtf8FileDescriptorBound } from "./descriptor-read.js";',
  'import { readBoundedFileBuffer } from "./bounded-file.js";\nimport { assertBoundedCheckpointJsonStructure } from "./checkpoint-json-complexity.js";',
  'legacy recovery descriptor import'
);
storage = replaceOnce(
  storage,
  'const MAX_SIGNING_LINE_BYTES = 1_024;',
  'const MAX_SIGNING_LINE_BYTES = 1_024;\nexport const MAX_RECOVERY_CHECKPOINT_FILE_BYTES = 65 * 1024 * 1024;',
  'storage constants'
);
storage = replaceOnce(
  storage,
  '    const value = JSON.parse(await readRegularUtf8FileDescriptorBound(join(dataDir, "recovery-checkpoint.json"))) as unknown;',
  `    const checkpointBytes = await readBoundedFileBuffer(\n      join(dataDir, "recovery-checkpoint.json"),\n      MAX_RECOVERY_CHECKPOINT_FILE_BYTES,\n      "Recovery checkpoint"\n    );\n    assertBoundedCheckpointJsonStructure(checkpointBytes);\n    const value = JSON.parse(checkpointBytes.toString("utf8")) as unknown;`,
  'recovery checkpoint read'
);
await writeFile(storagePath, storage, 'utf8');

const testPath = 'l1/test/recovery-checkpoint-bounds.test.ts';
await writeFile(testPath, `import assert from "node:assert/strict";\nimport test from "node:test";\nimport { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\n\nimport { publicKeyFromPrivate, addressFromPublicKey } from "../src/crypto.js";\nimport { ChainStore, MAX_RECOVERY_CHECKPOINT_FILE_BYTES } from "../src/storage.js";\nimport type { GenesisConfig } from "../src/types.js";\n\nconst validatorPrivateKey = "01".padStart(64, "0");\nconst validatorPublicKey = publicKeyFromPrivate(validatorPrivateKey);\nconst validatorAddress = addressFromPublicKey(validatorPublicKey);\nconst activityPool = addressFromPublicKey(publicKeyFromPrivate("02".padStart(64, "0")));\nconst activityOracle = publicKeyFromPrivate("03".padStart(64, "0"));\n\nfunction genesis(): GenesisConfig {\n  return {\n    chainId: "bounded-recovery-checkpoint-test",\n    timestampMs: 1_700_000_000_000,\n    validators: [{ address: validatorAddress, publicKey: validatorPublicKey }],\n    activityOracles: [activityOracle],\n    activityPool,\n    allocations: [{ address: activityPool, amountAtoms: 1_000 }]\n  };\n}\n\nasync function createFinalizedCheckpoint(dataDir: string): Promise<void> {\n  const store = await ChainStore.open(genesis(), dataDir);\n  const proposal = store.chain.produceBlock([], validatorPrivateKey, { timestampMs: genesis().timestampMs + 1 });\n  const finalized = store.chain.attestBlock(proposal, validatorPrivateKey);\n  await store.commitFinalizedBlock(finalized, genesis().timestampMs + 1);\n  await store.writeRecoveryCheckpoint();\n}\n\nasync function assertAuthoritativeReplay(dataDir: string): Promise<void> {\n  const reopened = await ChainStore.open(genesis(), dataDir);\n  assert.equal(reopened.chain.height, 1);\n  assert.equal(reopened.recoveredFromCheckpointHeight, 0);\n}\n\ntest("oversized recovery checkpoint is rejected before allocation and finalized history remains authoritative", async () => {\n  const dataDir = await mkdtemp(join(tmpdir(), "zyron-recovery-bound-"));\n  try {\n    await createFinalizedCheckpoint(dataDir);\n    await truncate(join(dataDir, "recovery-checkpoint.json"), MAX_RECOVERY_CHECKPOINT_FILE_BYTES + 1);\n    await assertAuthoritativeReplay(dataDir);\n  } finally {\n    await rm(dataDir, { recursive: true, force: true });\n  }\n});\n\ntest("over-deep recovery checkpoint JSON is rejected before JSON.parse and finalized history remains authoritative", async () => {\n  const dataDir = await mkdtemp(join(tmpdir(), "zyron-recovery-complexity-"));\n  try {\n    await createFinalizedCheckpoint(dataDir);\n    const overDeep = "[".repeat(65) + "0" + "]".repeat(65);\n    await writeFile(join(dataDir, "recovery-checkpoint.json"), overDeep, { mode: 0o600 });\n    await assertAuthoritativeReplay(dataDir);\n  } finally {\n    await rm(dataDir, { recursive: true, force: true });\n  }\n});\n`, 'utf8');

const docsPath = 'docs/RECOVERY_CHECKPOINT_BOUNDS.md';
await writeFile(docsPath, `# Local recovery checkpoint resource bounds\n\nThe local \`recovery-checkpoint.json\` fast path is optional recovery metadata, never a trust source above finalized history. The reader therefore fails closed before JSON materialization when the file is oversized, structurally pathological, non-regular, or changes identity while being read.\n\n- The file ceiling is 65 MiB: enough for the canonical <=64 MiB snapshot format plus checkpoint envelope metadata.\n- The shared bounded-file reader freezes the canonical path before open, validates the opened regular descriptor, and revalidates the pathname after open and after the bounded read. POSIX also uses no-follow/non-blocking flags.\n- Checkpoint JSON is scanned with the canonical checkpoint depth/cardinality limits before \`JSON.parse()\`.\n- Invalid checkpoint input disables the fast path and falls back to authoritative finalized-history replay. If finalized history has already been pruned, the existing invariant still requires a valid compatible checkpoint and startup fails closed instead of inventing state.\n\nThis control reduces local recovery memory/TOCTOU exposure. It does **not** close the target-hardware recovery evidence required by issue #383 and does not change public-testnet, mainnet, mining, governance, consensus, or finality activation gates.\n`, 'utf8');

const workflowPath = '.github/workflows/bounded-state-file-windows.yml';
let workflow = await readFile(workflowPath, 'utf8');
workflow = replaceOnce(
  workflow,
  "      - 'l1/src/cli-recovery-file.ts'\n      - 'l1/test/cli-recovery-file.test.ts'",
  "      - 'l1/src/cli-recovery-file.ts'\n      - 'l1/test/cli-recovery-file.test.ts'\n      - 'l1/src/storage.ts'\n      - 'l1/test/recovery-checkpoint-bounds.test.ts'\n      - 'docs/RECOVERY_CHECKPOINT_BOUNDS.md'",
  'bounded Windows workflow paths'
);
workflow = replaceOnce(
  workflow,
  'dist/test/state-v2-metadata-security.test.js dist/test/cli-recovery-file.test.js',
  'dist/test/state-v2-metadata-security.test.js dist/test/cli-recovery-file.test.js dist/test/recovery-checkpoint-bounds.test.js',
  'bounded Windows workflow tests'
);
await writeFile(workflowPath, workflow, 'utf8');
