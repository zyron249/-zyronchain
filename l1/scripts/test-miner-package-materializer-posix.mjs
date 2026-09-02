#!/usr/bin/env node
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeMinerPackagePosix } from './materialize-miner-package-posix.mjs';

if (process.platform === 'win32') {
  const temp = await mkdtemp(join(tmpdir(), 'zyron-miner-package-materializer-windows-test-'));
  const root = join(temp, 'l1');
  const outRoot = join(root, 'miner-release');
  let failedClosed = false;
  try {
    await materializeMinerPackagePosix({
      root,
      outRoot,
      bundleName: 'ZyronMiner-windows-test-x64',
      nodeName: 'node.exe'
    });
  } catch (error) {
    if (error?.message === 'descriptor-relative miner materialization is not implemented on Windows') {
      failedClosed = true;
    } else {
      throw error;
    }
  }
  if (!failedClosed) throw new Error('Windows miner materializer did not fail closed before unsupported custody could run');
  try {
    await access(root);
    throw new Error('Windows fail-closed materializer created filesystem state before rejecting the unsupported platform');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  console.log('PASS: Windows miner package materialization fails closed before creating candidate filesystem state.');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const repositoryL1 = resolve(here, '..');
const helperSource = join(repositoryL1, 'native', 'miner-custody-posix.c');
const materializerSource = join(repositoryL1, 'scripts', 'materialize-miner-package-posix.mjs');
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
  const materializerText = await readFile(materializerSource, 'utf8');
  if (/^#define O_NOFOLLOW 0$/m.test(helperText)) {
    throw new Error('destination/source custody silently disables O_NOFOLLOW');
  }
  if (/^#define O_DIRECTORY 0$/m.test(helperText)) {
    throw new Error('destination/source custody silently disables directory-open protection');
  }
  if (!helperText.includes('#error "miner destination/source custody requires O_NOFOLLOW"')) {
    throw new Error('destination/source custody does not fail closed when O_NOFOLLOW is unavailable');
  }
  if (!helperText.includes('copy_child_file_from_dir') || !helperText.includes('openat(source_dir_fd, source_name')) {
    throw new Error('production destination helper does not copy from a retained source-directory descriptor');
  }
  if (!helperText.includes('SOURCE_ENTER') || !helperText.includes('COPYREL')) {
    throw new Error('production custody session is missing retained source traversal/copy commands');
  }
  if (!helperText.includes('static void assert_directory_fd') || !helperText.includes('S_ISDIR(st.st_mode)')) {
    throw new Error('custody helper does not verify opened directory descriptors with fstat');
  }
  if (materializerText.includes('`COPY\\t${destinationName}\\t${sourcePath}`')) {
    throw new Error('materializer regressed to pathname COPY');
  }
  if (!materializerText.includes('`COPYREL\\t${destinationName}\\t${sourceName}`') || !materializerText.includes('`SOURCE_ENTER\\t${component}`')) {
    throw new Error('materializer does not use retained descriptor-relative source copy/traversal');
  }
  if (!materializerText.includes("ignoredDirectoryNames: new Set(['.bin'])")) {
    throw new Error('materializer does not explicitly omit npm executable shim directories from runtime dependency payloads');
  }
  if (!materializerText.includes('await assertBoundRootPath(canonicalOutRoot, boundOutRootStat)')) {
    throw new Error('materializer does not bind successful completion to the release-root pathname identity');
  }

  await mkdir(join(root, 'dist', 'src'), { recursive: true });
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'node_modules', 'fixture-pkg'), { recursive: true });
  await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
  await mkdir(outRoot, { recursive: true });

  await writeFile(join(root, 'dist', 'src', 'index.js'), 'export const fixture = true;\n');
  for (const name of ['mine.mjs', 'miner-rpc-response.mjs', 'miner-launcher.mjs', 'miner-launcher-security.mjs']) {
    await writeFile(join(root, 'scripts', name), `// ${name}\n`);
  }
  await writeFile(join(root, 'scripts', 'development-only.mjs'), '// must not ship\n');
  await writeFile(join(root, 'node_modules', 'fixture-pkg', 'index.js'), 'module.exports = 1;\n');
  await symlink('../fixture-pkg/index.js', join(root, 'node_modules', '.bin', 'fixture-cli'));
  await writeFile(join(root, 'miner-network-profile.json'), '{"activated":false}\n');
  await writeFile(join(root, 'package.json'), '{"name":"fixture"}\n');
  await writeFile(join(root, 'MINING.md'), '# Fixture mining\n');

  const bundle = await materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName: 'node', helperSource });

  if ((await readFile(join(bundle, 'dist', 'src', 'index.js'), 'utf8')) !== 'export const fixture = true;\n') {
    throw new Error('descriptor-relative materializer changed dist/src payload');
  }
  if ((await readFile(join(bundle, 'scripts', 'mine.mjs'), 'utf8')) !== '// mine.mjs\n') {
    throw new Error('descriptor-relative materializer changed packaged script payload');
  }
  if ((await readFile(join(bundle, 'node_modules', 'fixture-pkg', 'index.js'), 'utf8')) !== 'module.exports = 1;\n') {
    throw new Error('descriptor-relative materializer changed node_modules payload');
  }
  await assertMissing(join(bundle, 'node_modules', '.bin'), 'materializer copied npm executable shim symlinks into the runtime dependency payload');
  await assertMissing(join(bundle, 'scripts', 'development-only.mjs'), 'materializer broadened the packaged script allowlist');
  await assertMissing(join(bundle, 'dist-src'), 'materializer emitted an invalid dist-src layout');

  let duplicateFailed = false;
  try {
    await materializeMinerPackagePosix({ root, outRoot, bundleName, nodeName: 'node', helperSource });
  } catch {
    duplicateFailed = true;
  }
  if (!duplicateFailed) throw new Error('descriptor-relative materializer reused an existing bundle directory');

  const replacingHelperSource = join(temp, 'replace-root-helper.c');
  await writeFile(replacingHelperSource, `
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "session") != 0) return 64;
  const char *root = argv[2];
  puts("READY"); fflush(stdout);
  char line[8192];
  while (fgets(line, sizeof(line), stdin)) {
    if (strcmp(line, "END\\n") == 0) {
      size_t n = strlen(root) + 16;
      char *moved = malloc(n);
      if (!moved) return 70;
      snprintf(moved, n, "%s.replaced", root);
      if (rename(root, moved) != 0) return 71;
      if (mkdir(root, 0700) != 0) return 72;
      free(moved);
      puts("OK END"); fflush(stdout);
      return 0;
    }
    if (strcmp(line, "LEAVE\\n") == 0) puts("OK LEAVE");
    else if (strcmp(line, "SOURCE_LEAVE\\n") == 0) puts("OK SOURCE_LEAVE");
    else if (strncmp(line, "SOURCE\\t", 7) == 0) puts("OK SOURCE");
    else if (strncmp(line, "SOURCE_ENTER\\t", 13) == 0) puts("OK SOURCE_ENTER");
    else if (strncmp(line, "RESERVE\\t", 8) == 0) puts("OK RESERVE");
    else if (strncmp(line, "ENTER\\t", 6) == 0) puts("OK ENTER");
    else if (strncmp(line, "COPYREL\\t", 8) == 0) puts("OK COPYREL");
    else return 73;
    fflush(stdout);
  }
  return 74;
}
`, 'utf8');

  let rootReplacementFailed = false;
  try {
    await materializeMinerPackagePosix({
      root,
      outRoot,
      bundleName: `${bundleName}-root-replacement`,
      nodeName: 'node',
      helperSource: replacingHelperSource
    });
  } catch (error) {
    if (error?.message === 'miner release root pathname identity changed during materialization') {
      rootReplacementFailed = true;
    } else {
      throw error;
    }
  }
  if (!rootReplacementFailed) throw new Error('materializer acknowledged success after the bound release-root pathname was replaced');

  await symlink('index.js', join(root, 'node_modules', 'fixture-pkg', 'linked.js'));
  let symlinkFailed = false;
  try {
    await materializeMinerPackagePosix({ root, outRoot, bundleName: `${bundleName}-symlink`, nodeName: 'node', helperSource });
  } catch {
    symlinkFailed = true;
  }
  if (!symlinkFailed) throw new Error('retained source custody accepted a source symlink instead of failing closed');

  console.log('PASS: miner materializer keeps descriptor-relative source/destination custody, binds successful completion to the original release-root pathname identity, rejects unsafe source symlinks, and refuses an existing bundle.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
