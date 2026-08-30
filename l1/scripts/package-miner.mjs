#!/usr/bin/env node
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMinerPackagingCustodyReady } from './miner-packaging-custody-gate.mjs';
import { bindMinerReleaseRoot } from './miner-release-root.mjs';
import { materializeMinerPackagePosix } from './materialize-miner-package-posix.mjs';

// The activation gate remains fail-closed. When #761 is eventually proven complete and
// this gate is intentionally lifted, all POSIX candidate bytes below flow through the
// retained descriptor session rather than pathname-based rm/mkdir/cp/writeFile/chmod.
assertMinerPackagingCustodyReady();

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outRoot = bindMinerReleaseRoot(root, resolve(root, 'miner-release'));
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
if (!platform) throw new Error(`Unsupported miner package platform: ${process.platform}`);

const arch = process.arch;
const bundleName = `ZyronMiner-${platform}-${arch}`;
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';

// Windows remains intentionally unsupported by the descriptor-relative materializer and
// therefore fail-closed even if the quarantine gate is lifted in a future audited change.
const bundle = await materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName });

console.log(JSON.stringify({ bundle, bundleName, platform, arch, runtime: basename(process.execPath) }));
