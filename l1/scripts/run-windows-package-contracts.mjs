#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
for (const script of ['test-windows-miner-package-contract.mjs', 'verify-windows-miner-package-files.mjs', 'test-windows-miner-readiness.mjs', 'test-windows-package-static.mjs']) {
  const result = spawnSync(process.execPath, [join(here, script)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
