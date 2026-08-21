#!/usr/bin/env node
import { readFile, writeFile, rm } from 'node:fs/promises';

const cliPath = new URL('../src/cli.ts', import.meta.url);
let cli = await readFile(cliPath, 'utf8');

const importNeedle = 'import { readPrivateRegularFile } from "./local-security.js";\n';
const importLine = 'import { readCliCheckpointSnapshotAnchoredUtf8, readCliGenesisUtf8 } from "./cli-recovery-file.js";\n';
if (!cli.includes(importLine)) {
  if (!cli.includes(importNeedle)) throw new Error('legacy CLI import anchor not found');
  cli = cli.replace(importNeedle, importNeedle + importLine);
}

const rawGenesis = 'JSON.parse(await readFile(resolve(genesisPath), "utf8")) as GenesisConfig';
const boundedGenesis = 'JSON.parse(await readCliGenesisUtf8(resolve(genesisPath))) as GenesisConfig';
const genesisCount = cli.split(rawGenesis).length - 1;
if (genesisCount !== 6) throw new Error(`expected 6 raw recovery/node genesis reads, found ${genesisCount}`);
cli = cli.split(rawGenesis).join(boundedGenesis);

const rawSnapshot = 'JSON.parse(await readFile(resolve(snapshotPath), "utf8")) as unknown';
const boundedSnapshot = 'JSON.parse(await readCliCheckpointSnapshotAnchoredUtf8(resolve(snapshotPath), snapshotSha256)) as unknown';
if ((cli.split(rawSnapshot).length - 1) !== 1) throw new Error('expected one raw checkpoint snapshot read');
cli = cli.replace(rawSnapshot, boundedSnapshot);

if (cli.includes('readFile(resolve(genesisPath), "utf8")')) throw new Error('raw genesis read remains in legacy CLI');
if (cli.includes('readFile(resolve(snapshotPath), "utf8")')) throw new Error('raw checkpoint snapshot read remains in legacy CLI');
await writeFile(cliPath, cli);

const testPath = new URL('../test/legacy-cli-recovery-custody.test.ts', import.meta.url);
await writeFile(testPath, `import assert from "node:assert/strict";\nimport { readFile } from "node:fs/promises";\nimport test from "node:test";\n\nimport { CLI_CHECKPOINT_SNAPSHOT_MAX_BYTES, CLI_GENESIS_MAX_BYTES, readCliCheckpointSnapshotAnchoredUtf8, readCliGenesisUtf8 } from "../src/cli-recovery-file.js";\n\ntest("direct legacy CLI recovery and node-state commands use bounded recovery readers", async () => {\n  const source = await readFile(new URL("../../src/cli.ts", import.meta.url), "utf8");\n  assert.match(source, /readCliGenesisUtf8/);\n  assert.match(source, /readCliCheckpointSnapshotAnchoredUtf8/);\n  assert.equal(source.includes('readFile(resolve(genesisPath), "utf8")'), false);\n  assert.equal(source.includes('readFile(resolve(snapshotPath), "utf8")'), false);\n  const genesisUses = source.match(/readCliGenesisUtf8\\(resolve\\(genesisPath\\)\\)/g) ?? [];\n  assert.equal(genesisUses.length, 6);\n  assert.match(source, /readCliCheckpointSnapshotAnchoredUtf8\\(resolve\\(snapshotPath\\), snapshotSha256\\)/);\n});\n\ntest("direct legacy recovery readers retain production byte ceilings", async () => {\n  assert.equal(CLI_GENESIS_MAX_BYTES, 256 * 1024);\n  assert.equal(CLI_CHECKPOINT_SNAPSHOT_MAX_BYTES, 64 * 1024 * 1024);\n  await assert.rejects(() => readCliGenesisUtf8("/definitely/not/a/genesis.json"));\n  await assert.rejects(\n    () => readCliCheckpointSnapshotAnchoredUtf8("/definitely/not/a/checkpoint.json", "ABC"),\n    /lowercase 32-byte SHA-256 anchor/\n  );\n});\n`);

const docPath = new URL('../../docs/LEGACY_CLI_RECOVERY_CUSTODY.md', import.meta.url);
await writeFile(docPath, `# Legacy CLI recovery file custody\n\nThe published \\`zyron-l1\\` entrypoint continues to stage operator-controlled recovery files through \\`secure-cli\\`. Direct invocation of the compiled legacy CLI is now defense-in-depth hardened as well. Recovery and node-state commands read \\`--genesis\\` through the same bounded descriptor/path-custody reader, and direct \\`checkpoint-install\\` reads the snapshot through the SHA-256-anchored bounded checkpoint reader before JSON parsing.\n\nThe direct path therefore preserves the 256 KiB genesis ceiling, 64 MiB checkpoint ceiling, canonical-path freeze, post-open/post-read revalidation, POSIX no-follow/non-blocking behavior, checkpoint digest-before-parse ordering, and checkpoint JSON complexity gate. Published secure staging remains the supported entrypoint and is not bypassed or weakened by this additional layer.\n\nThis is local integrity/availability hardening only. It does not alter consensus/finality, validator key custody, mining/rewards, public-mining, public-testnet, mainnet, or release-publication gates, and it does not satisfy the target-hardware recovery evidence tracked separately.\n`);

await rm(new URL(import.meta.url));
