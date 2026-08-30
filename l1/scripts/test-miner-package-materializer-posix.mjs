#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeMinerPackagePosix } from './materialize-miner-package-posix.mjs';

if (process.platform === 'win32') {
  console.log('POSIX miner package materializer is unsupported on Windows; packaging remains fail-closed.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const repositoryL1 = resolve(here, '..');
const helperSource = join(repositoryL1, 'native', 'miner-custody-posix.c');
const temp = await mkdtemp(join(tmpdir(), 'zyron-miner-package-materializer-test-'));
const root = join(temp, 'l1');
const outRoot = join(root, 'miner-release');
const bundleName = 'ZyronMiner-test-x64';

async function assertMissing(path, message) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(message);
}

try {
  const helperText = await readFile(helperSource, 'utf8');
  if (/^#define O_NOFOLLOW 0$/m.test(helperText)) {
    throw new Error('destination custody silently disables O_NOFOLLOW');
  }
  if (/^#define O_DIRECTORY 0$/m.test(helperText)) {
    throw new Error('destination custody silently disables directory-open protection');
  }
  if (!helperText.includes('#error "miner destination custody requires O_NOFOLLOW"')) {
    throw new Error('destination custody does not fail closed when O_NOFOLLOW is unavailable');
  }
  if (!helperText.includes('static void assert_directory_fd') || !helperText.includes('S_ISDIR(st.st_mode)')) {
    throw new Error('destination custody does not verify opened directory descriptors with fstat');
  }

  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'fixture-pkg'), { recursive: true });
  await mkdir(outRoot, { recursive: true });

  await writeFile(join(root, 'dist', 'src', 'index.js'), 'export const fixture = true;\n');
  for (const name of ['mine.mjs', 'miner-rpc-response.mjs', 'miner-launcher.mjs', 'miner-launcher-security.mjs']) {
    await writeFile(join(root, 'scripts', name), `// ${name}\n`);
  }
  await writeFile(join(root, 'scripts', 'development-only.mjs'), '// must not ship\n');
  await writeFile(join(root, 'node_modules', 'fixture-pkg', 'index.js'), 'module.exports = 1;\n');
  await writeFile(join(root, 'miner-network-profile.json'), '{"activated":false}\n');
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(root, 'MINING.md'), '# Fixture mining\n');

  const bundle = await materializeMinerPackagePosix({
    root,
    outRoot,
    bundleName,
    nodeName: 'node',
    helperSource
  });

  if ((await readFile(join(bundle, 'dist', 'src', 'index.js'), 'utf8')) !== 'export const fixture = true;\n') {
    throw new Error('descriptor-relative materializer changed dist/src payload');
  }
  if ((await readFile(join(bundle, 'scripts', 'mine.mjs'), 'utf8')) !== '// mine.mjs\n') {
    throw new Error('descriptor-relative materializer changed packaged script payload');
  }
  if ((await readFile(join(bundle, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')) !== 'module.exports = 1;\n') {
    throw new Error('descriptor-relative materializer changed node_modules payload');
  }
  await assertMissing(join(bundle, 'scripts', 'development-only.mjs'), 'materializer broadened the packaged script allowlist');
  await assertMissing(join(bundle, 'dist-src'), 'materializer emitted an invalid dist-src layout');

  let duplicateFailed = false;
  try {
    await materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName: 'node', helperSource });
  } catch {
    duplicateFailed = true;
  }
  if (!duplicateFailed) throw new Error('descriptor-relative materializer reused an existing bundle directory');

  console.log('PASS: descriptor-relative miner package materializer preserves package layout/allowlist, rejects unsafe destination-custody fallbacks, and fails closed instead of replacing an existing bundle.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
