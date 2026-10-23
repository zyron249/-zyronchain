#!/usr/bin/env node
// Mining is retired (owner decision 2026-09-30). The historical page must be a plain retired notice:
// no miner platform controls, downloads, commands, buttons or hashrate, and the site script carries no miner path.
import fs from 'node:fs';

const html = fs.readFileSync(new URL('./mining.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

if (/data-miner-platform=/.test(html)) throw new Error('retired mining page must not carry miner platform controls');
if (/<button\b|<form\b/i.test(html)) throw new Error('retired mining page must not carry buttons or forms');
if (/npm run mine|hashrate|releases\/download|Download Zyron Miner/i.test(html)) throw new Error('retired mining page must not carry miner commands or downloads');
if (html.includes('http://127.0.0.1:9137')) throw new Error('mining page must not present a local miner RPC');
if (/MINER_DISTRIBUTION|ZyronMiner|releases\/download|Download Zyron Miner|location\.assign/.test(app)) throw new Error('website script must not carry any miner download path (mining is retired)');
if (!html.includes('Mining is retired') || !/<meta name="robots" content="noindex"/.test(html)) throw new Error('historical mining page must be marked retired and noindex');
if (/fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(/.test(app)) throw new Error('website script must not fetch activation/distribution state');
console.log('retired mining page carries no live mining UI');
