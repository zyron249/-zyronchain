#!/usr/bin/env node
import { readFile, writeFile, rm } from 'node:fs/promises';

const cliPath = 'l1/src/cli.ts';
let cli = await readFile(cliPath, 'utf8');
const importAnchor = 'import { readCliCheckpointSnapshotAnchoredUtf8, readCliGenesisUtf8 } from "./cli-recovery-file.js";\n';
if (!cli.includes(importAnchor)) throw new Error('missing cli recovery import anchor');
if (!cli.includes('readCliGovernanceArtifactUtf8')) {
  cli = cli.replace(importAnchor, `${importAnchor}import { readCliGovernanceArtifactUtf8 } from "./cli-governance-file.js";\n`);
}
const raw = 'JSON.parse(await readFile(path, "utf8"))';
const count = cli.split(raw).length - 1;
if (count !== 3) throw new Error(`expected 3 raw governance reads, found ${count}`);
cli = cli.replaceAll(raw, 'JSON.parse(await readCliGovernanceArtifactUtf8(path))');
await writeFile(cliPath, cli, 'utf8');

await rm('.github/scripts/patch-legacy-governance-custody.mjs', { force: true });
await rm('.github/workflows/patch-legacy-governance-custody.yml', { force: true });
