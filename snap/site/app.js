// Minimal example of how zyronchain.com could talk to the ZyronChain Snap.
// Plain browser JS, no build step. NOT deployed; see ../README.md.
'use strict';

// Public wallet testnet RPC (no value). Must match the RPC the Snap was built with.
const TESTNET_RPC_URL = 'https://zyron-wallet-testnet-rpc.onrender.com';

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
  // Signed only. zyron_sendTransfer is the method that submits to the testnet.
  return { note: 'Signed only; not broadcast.', signed };
}));

document.getElementById('balance').addEventListener('click', () => run(() =>
  invokeSnap('zyron_getBalance')));

document.getElementById('faucet').addEventListener('click', () => run(async () => {
  const { address } = await invokeSnap('zyron_getAddress');
  const response = await fetch(`${TESTNET_RPC_URL}/faucet`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address }),
  });
  return response.json();
}));

document.getElementById('send').addEventListener('click', () => run(() => {
  const receiver = document.getElementById('sendReceiver').value.trim();
  const amount = document.getElementById('sendAmount').value.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) throw new Error('Amount: up to 8 decimals');
  const [whole, fraction = ''] = amount.split('.');
  const amountAtoms = Number(whole) * 100000000 + Number(fraction.padEnd(8, '0'));
  return invokeSnap('zyron_sendTransfer', { receiver, amountAtoms });
}));
