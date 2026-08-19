#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const path = 'l1/src/node-base.ts';
let source = await readFile(path, 'utf8');
source = source.replace('export const MAX_PEER_RESPONSE_PARSE_BYTES_INFLIGHT = 128_000_000;', 'export const MAX_PEER_RESPONSE_PARSE_BYTES_INFLIGHT = 160_000_000;');
source = source.replace('const decodedBytes = totalBytes + (structuralTokens * PEER_RESPONSE_JSON_NODE_ESTIMATE_BYTES);', 'const decodedBytes = (totalBytes * 2) + (structuralTokens * PEER_RESPONSE_JSON_NODE_ESTIMATE_BYTES);');
if (!source.includes('MAX_PEER_RESPONSE_PARSE_BYTES_INFLIGHT = 160_000_000') || !source.includes('const decodedBytes = (totalBytes * 2) +')) throw new Error('peer response parse budget tuning failed');
await writeFile(path, source);

const docPath = 'docs/PEER_HTTP_JSON_PARSE_BUDGET.md';
let docs = await readFile(docPath, 'utf8');
docs = docs.replace('a decoded-graph allowance derived from wire bytes plus bounded structural cardinality', 'a conservative decoded-graph allowance derived from twice the wire bytes plus bounded structural cardinality');
await writeFile(docPath, docs);
