// Minimal example of how zyronchain.com could talk to the ZyronChain Snap.
// Plain browser JS, no build step. NOT deployed; see ../README.md.
'use strict';

// Local dev: the Snap served by `mm-snap serve/watch`. After an npm release
// (not done yet) this would become 'npm:@zyronchain/metamask-snap'.
const SNAP_ID = 'local:http://localhost:8080';

const out = document.getElementById('out');
const show = (value) => { out.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); };

// EIP-6963 provider discovery; prefer MetaMask Flask (Snaps dev builds).
const providers = [];
window.addEventListener('eip6963:announceProvider', (event) => providers.push(event.detail));
window.dispatchEvent(new Event('eip6963:requestProvider'));

function getProvider() {
  const pick = providers.find((p) => p.info.rdns === 'io.metamask.flask') ||
    providers.find((p) => p.info.rdns === 'io.metamask');
  if (pick) return pick.provider;
  if (window.ethereum) return window.ethereum;
  throw new Error('MetaMask (Flask) not found');
}

async function invokeSnap(method, params) {
  return getProvider().request({
    method: 'wallet_invokeSnap',
    params: { snapId: SNAP_ID, request: params === undefined ? { method } : { method, params } },
  });
}

async function run(action) {
  try { show(await action()); } catch (error) { show(`Error ${error.code ?? ''}: ${error.message}`); }
}

document.getElementById('connect').addEventListener('click', () => run(() =>
  getProvider().request({ method: 'wallet_requestSnaps', params: { [SNAP_ID]: {} } })));

document.getElementById('address').addEventListener('click', () => run(() =>
  invokeSnap('zyron_getAddress')));

document.getElementById('sign').addEventListener('click', () => run(async () => {
  const value = (id) => document.getElementById(id).value.trim();
  const transaction = {
    kind: 'transfer',
    version: Number(value('version')),
    chainId: value('chainId'),
    nonce: Number(value('nonce')),
    receiver: value('receiver'),
    amountAtoms: Number(value('amountAtoms')),
    feeAtoms: Number(value('feeAtoms')),
  };
  const { transaction: signed } = await invokeSnap('zyron_signTransaction', { transaction });
  // No public RPC exists yet, so nothing is submitted. With a node you
  // operate yourself, this object is the exact body the l1 node accepts at
  // POST <your-node>/tx (with the x-zyron-rpc-version header; see
  // l1/src/cli.ts submitTransfer). There is no public endpoint to use.
  return { note: 'Signed only; NOT broadcast (no public RPC yet).', signed };
}));
