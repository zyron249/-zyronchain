#!/usr/bin/env node
import { readFileSync } from 'node:fs';

const server = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
const html = readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('./public/app.js', import.meta.url), 'utf8');
const windows = readFileSync(new URL('./start-windows.cmd', import.meta.url), 'utf8');

const requiredServer = [
  "server.listen(0, '127.0.0.1'",
  "request.headers['x-zyron-ui-token'] !== token",
  "if (!networkProfile.publicMiningActivated)",
  "join(homedir(), '.zyronchain', 'miner')",
  "join(l1Root, 'scripts', 'miner-launcher.mjs')",
  "/balance/",
  "'x-zyron-rpc-version': '1'",
  "Remote RPC must use HTTPS",
  "frame-ancestors 'none'"
];
for (const needle of requiredServer) {
  if (!server.includes(needle)) throw new Error(`desktop miner invariant missing: ${needle}`);
}

for (const forbidden of ['wallet.password', 'wallet.json']) {
  if (html.includes(forbidden) || app.includes(forbidden)) {
    throw new Error(`renderer must not request or expose secret custody path: ${forbidden}`);
  }
}

if (!html.includes('__ZYRON_UI_TOKEN__')) throw new Error('control token placeholder missing');
if (!app.includes("headers: { 'x-zyron-ui-token': token }")) throw new Error('renderer mutation token header missing');
if (!windows.includes('where node.exe')) throw new Error('Windows launcher must fail clearly when Node is missing');
if (/electron-builder|makensis|signtool|ZyronMiner-Setup\.exe/i.test(server + html + app + windows)) {
  throw new Error('development UI must not introduce a Windows publication/installer path');
}

console.log('Desktop miner development UI static security contract: PASS');
