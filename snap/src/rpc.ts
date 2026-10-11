/**
 * Minimal client for the public ZyronChain wallet TESTNET RPC
 * (l1/scripts/public-testnet-rpc.mjs, docs/WALLET_TESTNET_RPC.md).
 *
 * Test ZYN has no value. Every response is validated before use; the Snap
 * never sends key material, only public addresses and signed transfers.
 */
import { ADDRESS_PATTERN, CHAIN_ID_PATTERN, TESTNET_CHAIN_ID } from './constants';
import type { TransferTx } from './zyron/transfer';

declare const process: { env: Record<string, string | undefined> };

/** Injected at build time by snap.config.ts (`environment`). */
export const TESTNET_RPC_URL: string = String(process.env.ZYRON_TESTNET_RPC_URL).replace(/\/+$/u, '');

export class RpcError extends Error {}

export type TestnetStatus = {
  chainId: string;
  genesisHash: string;
  height: number;
  transactionVersion: 1 | 2;
};

export type TestnetAccount = {
  address: string;
  balanceAtoms: number;
  nonce: number;
  height: number;
};

const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const TIMEOUT_MS = 20_000;

/**
 * Fetches a JSON object from the testnet RPC.
 *
 * @param path - Path starting with "/".
 * @param init - Optional POST body.
 * @param init.body - JSON value to POST.
 * @returns Parsed JSON object and HTTP status.
 */
async function call(path: string, init?: { body: unknown }): Promise<{ status: number; body: Record<string, unknown> }> {
  let response: Response;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    response = await fetch(`${TESTNET_RPC_URL}${path}`, {
      method: init ? 'POST' : 'GET',
      headers: init ? { 'content-type': 'application/json' } : {},
      body: init ? JSON.stringify(init.body) : null,
      signal: controller.signal,
    });
  } catch {
    throw new RpcError(
      'ZyronChain testnet RPC is unreachable. The free server may be waking up; try again in a minute.',
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await response.text();
  if (text.length > 64 * 1024) {
    throw new RpcError('Testnet RPC response too large');
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new RpcError(`Testnet RPC returned invalid JSON (HTTP ${response.status})`);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RpcError('Testnet RPC returned an unexpected response');
  }
  return { status: response.status, body: body as Record<string, unknown> };
}

/**
 * @param value - Value.
 * @returns Whether value is a safe non-negative integer.
 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads and checks the testnet status. Refuses anything that is not the
 * no-value wallet testnet.
 *
 * @returns Status.
 */
export async function getStatus(): Promise<TestnetStatus> {
  const { status, body } = await call('/status');
  if (status !== 200) {
    throw new RpcError(`Testnet RPC status failed (HTTP ${status})`);
  }
  const { chainId, genesisHash, height, transactionVersion, valueBearing } = body;
  if (typeof chainId !== 'string' || !CHAIN_ID_PATTERN.test(chainId) || chainId !== TESTNET_CHAIN_ID) {
    throw new RpcError(`RPC is not the ZyronChain wallet testnet (${TESTNET_CHAIN_ID})`);
  }
  if (valueBearing !== false) {
    throw new RpcError('RPC does not declare itself a no-value testnet');
  }
  if (typeof genesisHash !== 'string' || !HASH_PATTERN.test(genesisHash) || !isCount(height)) {
    throw new RpcError('Testnet RPC returned an invalid status');
  }
  if (transactionVersion !== 1 && transactionVersion !== 2) {
    throw new RpcError('Testnet RPC returned an invalid transaction version');
  }
  return { chainId, genesisHash, height, transactionVersion };
}

/**
 * Reads balance and nonce for an address.
 *
 * @param address - ZYN address.
 * @returns Account state.
 */
export async function getAccountState(address: string): Promise<TestnetAccount> {
  if (!ADDRESS_PATTERN.test(address)) {
    throw new RpcError('Invalid address');
  }
  const { status, body } = await call(`/account/${address}`);
  if (status !== 200) {
    throw new RpcError(`Testnet RPC account lookup failed (HTTP ${status})`);
  }
  if (body.address !== address || !isCount(body.balanceAtoms) || !isCount(body.nonce) || !isCount(body.height)) {
    throw new RpcError('Testnet RPC returned an invalid account');
  }
  return { address, balanceAtoms: body.balanceAtoms, nonce: body.nonce, height: body.height };
}

/**
 * Submits a signed transfer.
 *
 * @param tx - Signed transfer.
 * @returns The accepted transaction ID.
 */
export async function submitTransfer(tx: TransferTx): Promise<string> {
  const { status, body } = await call('/tx', { body: tx });
  if (status !== 200 || body.accepted !== true) {
    const reason = typeof body.error === 'string' ? body.error.slice(0, 200) : `HTTP ${status}`;
    throw new RpcError(`Testnet RPC rejected the transfer: ${reason}`);
  }
  if (body.txid !== tx.txid) {
    throw new RpcError('Testnet RPC returned a different transaction ID');
  }
  return tx.txid;
}
