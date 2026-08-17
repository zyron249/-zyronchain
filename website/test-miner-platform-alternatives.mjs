#!/usr/bin/env node
import fs from 'node:fs';

const html = fs.readFileSync(new URL('./mining.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

for (const platform of ['windows', 'macos', 'linux']) {
  const marker = `data-miner-platform="${platform}"`;
  if (!html.includes(marker)) throw new Error(`missing manual ${platform} miner control`);
}
if ((html.match(/data-miner-platform=/g) || []).length !== 3) throw new Error('manual platform set must contain exactly three controls');
if ((html.match(/aria-disabled="true"/g) || []).length < 3) throw new Error('manual platform controls must remain aria-disabled');
if ((html.match(/data-miner-platform="(?:windows|macos|linux)" disabled/g) || []).length !== 3) throw new Error('all manual platform controls must remain disabled while mining is gated');
if (/data-miner-platform="(?:windows|macos|linux)"[^>]+href=/s.test(html)) throw new Error('manual platform controls must not carry download hrefs while gated');
if (!html.includes('operating system still requires user consent')) throw new Error('manual platform UX must preserve explicit execution-consent boundary');
if (!app.includes('enabled: false') || !app.includes('publicMiningActivated: false')) throw new Error('website miner activation must remain fail-closed');
if (!app.includes('assets: Object.freeze({ windows: null, macos: null, linux: null })')) throw new Error('website miner assets must remain null');
if (/fetch\s*\(|XMLHttpRequest|WebSocket\s*\(|EventSource\s*\(/.test(app)) throw new Error('website miner UX must not fetch activation/distribution state');
console.log('manual miner platform alternatives remain fail-closed');
