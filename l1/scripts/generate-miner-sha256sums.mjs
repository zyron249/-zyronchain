#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function collectReleaseFiles(root, fsOps = fs) {
  const absoluteRoot = path.resolve(root);
  const manifestPath = path.join(absoluteRoot, 'SHA256SUMS');
  const files = [];

  function walk(dir) {
    for (const entry of fsOps.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        if (path.resolve(full) !== manifestPath) files.push(full);
        continue;
      }
      throw new Error(`unsupported non-regular miner release entry: ${path.relative(absoluteRoot, full) || entry.name}`);
    }
  }

  walk(absoluteRoot);
  return files.sort();
}

export function generateMinerSha256Sums(root, fsOps = fs) {
  const absoluteRoot = path.resolve(root);
  const files = collectReleaseFiles(absoluteRoot, fsOps);
  const lines = files.map((file) => {
    const digest = crypto.createHash('sha256').update(fsOps.readFileSync(file)).digest('hex');
    const relative = path.relative(process.cwd(), file).replaceAll('\\', '/');
    return `${digest}  ${relative}`;
  });
  const manifest = `${lines.join('\n')}\n`;
  fsOps.writeFileSync(path.join(absoluteRoot, 'SHA256SUMS'), manifest);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] || 'miner-release';
  generateMinerSha256Sums(root);
}
