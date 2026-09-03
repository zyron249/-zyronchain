#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sameDirectoryIdentity } from './materialize-miner-package-posix.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const materializerPath = resolve(here, 'materialize-miner-package-posix.mjs');
const materializerText = await readFile(materializerPath, 'utf8');

const adjacentHighIdentityA = 9007199254740992n;
const adjacentHighIdentityB = 9007199254740993n;
if (Number(adjacentHighIdentityA) !== Number(adjacentHighIdentityB)) {
  throw new Error('regression fixture no longer demonstrates Number precision collapse above 2^53');
}
if (sameDirectoryIdentity(
  { dev: 1n, ino: adjacentHighIdentityA },
  { dev: 1n, ino: adjacentHighIdentityB }
)) {
  throw new Error('exact miner custody identity comparison collapsed adjacent >2^53 inode values');
}
if (!sameDirectoryIdentity(
  { dev: adjacentHighIdentityB, ino: adjacentHighIdentityA },
  { dev: adjacentHighIdentityB, ino: adjacentHighIdentityA }
)) {
  throw new Error('exact miner custody identity comparison rejected identical BigInt identities');
}

if (!materializerText.includes("return lstat(path, { bigint: true });")) {
  throw new Error('miner materializer does not capture POSIX identities with BigInt-backed lstat');
}
for (const token of [
  'sourceStat.dev.toString()',
  'sourceStat.ino.toString()',
  'boundOutRootStat.dev.toString()',
  'boundOutRootStat.ino.toString()',
  'await lstatExact(rootPath)',
  'await lstatExact(sourceRoot)',
  'await lstatExact(sourcePath)',
  'await lstatExact(canonicalOutRoot)'
]) {
  if (!materializerText.includes(token)) throw new Error(`miner materializer is missing exact identity path: ${token}`);
}
for (const forbidden of [
  'String(sourceStat.dev)',
  'String(sourceStat.ino)',
  'String(boundOutRootStat.dev)',
  'String(boundOutRootStat.ino)',
  'Number(sourceStat.dev)',
  'Number(sourceStat.ino)',
  'Number(boundOutRootStat.dev)',
  'Number(boundOutRootStat.ino)'
]) {
  if (materializerText.includes(forbidden)) throw new Error(`miner materializer regressed to lossy identity coercion: ${forbidden}`);
}

console.log('PASS: miner custody preserves exact BigInt POSIX dev/inode identities and distinguishes adjacent values above 2^53.');
