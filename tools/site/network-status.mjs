#!/usr/bin/env node
// Static, build-time Network Status component for zyronchain.com.
//
// The same markup is injected between markers into every page that shows network state (home, Desktop Wallet
// Setup, Phone Wallet). Governance rows are generated from docs/l1-launch-authorization.json at build time.
// A separate progressive script (website/network-live.js) may poll the documented open-testnet gateway
// /readyz — that never flips activation flags and never claims mainnet or live trading.
//
//   node tools/site/network-status.mjs          -> rewrite pages in place
//   node tools/site/network-status.mjs --check  -> fail if any page is stale (CI)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const check = process.argv.includes('--check');
const auth = JSON.parse(readFileSync(join(repo, 'docs', 'l1-launch-authorization.json'), 'utf8'));

if (auth.publicTestnetActivationAllowed !== false || auth.mainnetActivationAllowed !== false) {
  throw new Error('docs/l1-launch-authorization.json allows activation: review and update tools/site/network-status.mjs rows before publishing');
}
const governance = auth.publicTestnetAuthorized && auth.mainnetAuthorized
  ? { value: 'Authorized', note: 'Public testnet and mainnet authorized by governance. Activation is not allowed yet.' }
  : auth.publicTestnetAuthorized
    ? { value: 'Authorized (public testnet)', note: 'Public testnet authorized by governance. Activation is not allowed yet.' }
    : { value: 'Not authorized', note: 'No governance authorization recorded.' };

// Documented no-value open testnet (docs/OPEN_TESTNET.md). Formal activation flags stay false.
export const OPEN_TESTNET_GATEWAY = 'https://zyron-open-testnet.onrender.com';

// kind: on = available, off = unavailable / not active, gov = authorized but gated / open no-value, retired, none.
export const ROWS = [
  { key: 'governance', label: 'Governance', kind: 'gov', ...governance },
  {
    key: 'public-testnet',
    label: 'Public testnet',
    kind: 'gov',
    value: 'Open no-value profile',
    note: 'Unaudited hosted profile (docs/OPEN_TESTNET.md). Formal activation flags remain false. Free host may sleep when idle.'
  },
  {
    key: 'public-rpc',
    label: 'Public RPC',
    kind: 'gov',
    value: 'Open testnet gateway',
    note: 'No-value test ZYN only. Mainnet is off. Trading is not enabled. Gateway URL is shown in the readiness probe below.'
  },
  {
    key: 'explorer',
    label: 'Explorer',
    kind: 'gov',
    value: 'Open testnet page',
    note: 'Explorer and faucet live on the same no-value gateway. Formal activation remains gated.'
  },
  { key: 'wallet-creation', label: 'Wallet creation', kind: 'on', value: 'Available locally', note: 'Keys are created on your own device.' },
  { key: 'offline-signing', label: 'Offline signing', kind: 'on', value: 'Available', note: 'Can sign ≠ can broadcast to mainnet.' },
  {
    key: 'broadcasting',
    label: 'Broadcasting',
    kind: 'gov',
    value: 'Testnet transfers only',
    note: 'Signed transfers may be submitted to the open no-value gateway only. Mainnet broadcasting remains unavailable.'
  },
  { key: 'mining', label: 'Mining', kind: 'retired', value: 'Retired', note: 'Shut down on 2026-09-30. Do not run miner software.' },
  { key: 'token-sale', label: 'Token sale', kind: 'none', value: 'None', note: 'No sale, no price, no market.' }
];
const ICON = { on: '✓', off: '✕', gov: '◐', retired: '—', none: '—' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function render(options = {}) {
  const wallet = options.variant === 'wallet';
  const rows = ROWS.map((r) => wallet && r.key === 'broadcasting'
    ? { ...r, note: 'This phone app does not submit transfers. The Snap and the CLI can submit no-value test transfers on their own. Mainnet broadcasting remains unavailable.' }
    : r);
  const rowHtml = rows.map((r) => `      <tr data-ns-row="${r.key}"><th scope="row">${esc(r.label)}</th><td><span class="ns-state ns-${r.kind}"><span aria-hidden="true">${ICON[r.kind]}</span> ${esc(r.value)}</span><span class="ns-note">${esc(r.note)}</span></td></tr>`).join('\n');
  const sub = wallet
    ? 'Repository facts below are static. This phone wallet does not poll any network. This page does not claim that mainnet exists or that trading is enabled.'
    : 'Repository facts below are static. A progressive script may poll the documented open-testnet gateway <code>/readyz</code> (no-value only). This page does not claim that mainnet exists or that trading is enabled.';
  const liveLabel = wallet ? 'Open-testnet link' : 'Open-testnet readiness probe';
  const liveState = wallet
    ? 'This phone wallet does not connect, so it does not refresh <code>/readyz</code>. Open the gateway link to check the no-value open testnet.'
    : 'Enable JavaScript to refresh <code>/readyz</code>, or open the gateway link.';
  return [
    '<!-- BEGIN NETWORK STATUS (generated by tools/site/network-status.mjs; edit the script, not this block) -->',
    '<section class="netstatus" id="network-status" aria-labelledby="network-status-title" data-network-status>',
    '  <div class="ns-head">',
    '    <h2 id="network-status-title">Network status</h2>',
    `    <p class="ns-sub">${sub}</p>`,
    '  </div>',
    '  <table class="ns-table">',
    '    <caption class="sr-only">ZyronChain network capabilities as of this build</caption>',
    '    <tbody>',
    rowHtml,
    '    </tbody>',
    '  </table>',
    '  <div class="ns-live" data-ns-live aria-live="polite">',
    `    <p class="ns-live-label">${liveLabel}</p>`,
    `    <p class="ns-live-endpoint">Gateway: <a href="${esc(OPEN_TESTNET_GATEWAY)}" rel="noopener noreferrer">${esc(OPEN_TESTNET_GATEWAY)}</a> (Render free plan; may sleep when idle)</p>`,
    `    <p class="ns-live-state" data-ns-live-state>${liveState}</p>`,
    '    <p class="ns-live-detail" data-ns-live-detail></p>',
    '  </div>',
    '  <p class="ns-foot">Source: docs/l1-launch-authorization.json (formal public testnet and mainnet activation: not allowed yet) and docs/OPEN_TESTNET.md.</p>',
    '</section>',
    '<!-- END NETWORK STATUS -->'
  ].join('\n');
}

const PAGES = ['website/index.html', 'website/wallet.html', 'website/app/index.html'];
const BLOCK = /<!-- BEGIN NETWORK STATUS[\s\S]*?<!-- END NETWORK STATUS -->/;
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const stale = [];
  let found = 0;
  for (const page of PAGES) {
    const file = join(repo, page);
    if (!existsSync(file)) continue;
    const html = readFileSync(file, 'utf8');
    const match = html.match(BLOCK);
    if (!match) continue;
    found += 1;
    const indent = (html.slice(0, match.index).match(/[ \t]*$/) || [''])[0];
    const variant = page.includes('/app/') ? 'wallet' : 'site';
    const block = render(variant === 'wallet' ? { variant } : {}).split('\n').map((line, i) => (i === 0 ? line : indent + line)).join('\n');
    const next = html.replace(BLOCK, block);
    if (next !== html) { stale.push(page); if (!check) writeFileSync(file, next); }
  }
  if (!found) throw new Error('No page contains the NETWORK STATUS markers');
  if (check && stale.length) { console.error(`network status is stale in: ${stale.join(', ')}. Run node tools/site/network-status.mjs`); process.exit(1); }
  console.log(`network-status-${check ? 'ok' : 'written'} pages=${found}`);
}
