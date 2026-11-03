import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Unit test of the warning-state read-modify-write in src/index.tsx with a stubbed `snap` global.
// snaps-jest cannot hold two dialogs open at once, so an overlapping request is simulated by
// committing its state write while this request's confirmation dialog is open.
jest.mock('@noble/hashes/sha2.js', () => ({
  sha256: (data: Uint8Array) => new Uint8Array(jest.requireActual<typeof import('crypto')>('crypto').createHash('sha256').update(data).digest()),
}));
jest.mock('@noble/hashes/utils.js', () => ({
  bytesToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString('hex'),
  hexToBytes: (hex: string) => new Uint8Array(Buffer.from(hex, 'hex')),
  utf8ToBytes: (text: string) => new Uint8Array(Buffer.from(text, 'utf8')),
}));
const OWN = `ZYN${'12'.repeat(20)}`;
const RECEIVER = `ZYN${'ab'.repeat(20)}`;
const OTHER = `ZYN${'cd'.repeat(20)}`;
jest.mock('../src/keys', () => ({
  getAccount: async () => ({ address: `ZYN${'12'.repeat(20)}`, publicKey: 'pk' }),
  withAccountKey: async (fn: (key: Uint8Array, account: unknown) => unknown) =>
    fn(new Uint8Array(32), { address: `ZYN${'12'.repeat(20)}`, publicKey: 'pk' }),
}));
// Dialog content is not under test here.
jest.mock('../src/ui', () => ({ FeeRejectedWarning: () => null, MessageConfirmation: () => null, ThresholdConfirmation: () => null, TransferConfirmation: () => null }));
jest.mock('../src/zyron/message', () => ({ parseMessageRequest: () => 'm', signMessagePayload: () => 's' }));
jest.mock('../src/zyron/transfer', () => {
  class TransactionRequestError extends Error {}
  return {
    TransactionRequestError,
    assertPlainRecord: (value: unknown) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TransactionRequestError('params');
    },
    parseTransferRequest: (tx: Record<string, unknown>) => ({ ...tx }),
    signTransfer: (tx: unknown) => ({ signed: tx }),
  };
});
jest.mock('../src/rpc', () => ({
  RpcError: class RpcError extends Error {},
  TESTNET_RPC_URL: 'http://127.0.0.1:1',
  getAccountState: async () => ({ height: 1, balanceAtoms: 10 ** 12, nonce: 0 }),
  getStatus: async () => ({ chainId: 'zyron-snap-testnet-1', genesisHash: 'g', transactionVersion: 2 }),
  submitTransfer: async () => 'txid',
}));

import { onRpcRequest } from '../src/index';

type Stored = { known: { contacts: unknown[]; sent: string[]; thresholdAtoms: number | null } } | null;
let stored: Stored;
let duringDialog: (() => void) | undefined;

beforeEach(() => {
  stored = null;
  duringDialog = undefined;
  (globalThis as unknown as { snap: unknown }).snap = {
    request: async ({ method, params }: { method: string; params: any }) => {
      if (method === 'snap_manageState') {
        if (params.operation === 'get') return stored === null ? null : JSON.parse(JSON.stringify(stored));
        if (params.operation === 'update') {
          stored = JSON.parse(JSON.stringify(params.newState));
          return null;
        }
      }
      if (method === 'snap_dialog') {
        const hook = duringDialog;
        duringDialog = undefined;
        hook?.();
        return true;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
});

const call = async (method: string, params: unknown) =>
  (onRpcRequest as any)({ origin: 'https://zyronchain.com', request: { jsonrpc: '2.0', id: 1, method, params } });
const transfer = (receiver: string) => ({
  transaction: { kind: 'transfer', version: 2, chainId: 'zyron-snap-testnet-1', nonce: 1, receiver, amountAtoms: 5, feeAtoms: 100_000 },
});

describe('warning state is merged into the latest saved state (Codex P2 on #1149)', () => {
  it('a threshold saved while a transfer dialog is open survives that transfer', async () => {
    duringDialog = () => {
      stored = { known: { contacts: [], sent: [], thresholdAtoms: 150_000_000 } };
    };
    await call('zyron_signTransaction', transfer(RECEIVER));
    expect(stored?.known.thresholdAtoms).toBe(150_000_000);
    expect(stored?.known.sent).toContain(RECEIVER);
  });

  it('a receiver recorded while the threshold dialog is open survives the threshold change', async () => {
    duringDialog = () => {
      stored = { known: { contacts: [], sent: [OTHER], thresholdAtoms: null } };
    };
    await call('zyron_setWarningThreshold', { thresholdAtoms: 7 });
    expect(stored?.known.thresholdAtoms).toBe(7);
    expect(stored?.known.sent).toStrictEqual([OTHER]);
  });

  it('overlapping transfers both record their receivers', async () => {
    duringDialog = () => {
      stored = { known: { contacts: [], sent: [OTHER], thresholdAtoms: null } };
    };
    await call('zyron_sendTransfer', { receiver: RECEIVER, amountAtoms: 5 });
    expect(stored?.known.sent).toEqual(expect.arrayContaining([OTHER, RECEIVER]));
    expect(OWN).not.toBe(RECEIVER);
  });
});
