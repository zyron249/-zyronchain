import { beforeEach, describe, expect, it, jest } from '@jest/globals';

// Unit test of the warning state in src/index.tsx with a stubbed `snap` global.
// Covers the fail-closed, concurrency and history cases from the Security
// review of #1149 (AI review PoC), plus the two Low findings fixed afterwards.
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
// Dialog content is rendered elsewhere (send-warnings.test.ts); here only the props are recorded.
const mockDialogs: { kind: string; props: any }[] = [];
jest.mock('../src/ui', () => ({
  FeeRejectedWarning: () => null,
  HistorySaveFailedNotice: (props: unknown) => { mockDialogs.push({ kind: 'history-failed', props }); return null; },
  MessageConfirmation: () => null,
  ThresholdConfirmation: (props: unknown) => { mockDialogs.push({ kind: 'threshold', props }); return null; },
  TransferConfirmation: (props: unknown) => { mockDialogs.push({ kind: 'transfer', props }); return null; },
}));
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
const mockSubmit = { fail: false, calls: 0 };
jest.mock('../src/rpc', () => ({
  RpcError: class RpcError extends Error {},
  TESTNET_RPC_URL: 'http://127.0.0.1:1',
  getAccountState: async () => ({ height: 1, balanceAtoms: 10 ** 14, nonce: 0 }),
  getStatus: async () => ({ chainId: 'zyron-snap-testnet-1', genesisHash: 'g', transactionVersion: 2 }),
  submitTransfer: async () => {
    mockSubmit.calls += 1;
    if (mockSubmit.fail) throw new Error('submit failed');
    return 'txid';
  },
}));

import { onRpcRequest } from '../src/index';
import { emptyKnown } from '../src/send-warnings';

const DEFAULT_THRESHOLD_ATOMS = 1_000 * 100_000_000; // 1,000 ZYN

let mode: { get?: () => unknown; update?: () => unknown } = {};
let stored: any;
let writes: unknown[];
let submitCallsAtWrite: number[];
let dialogHook: (() => void) | undefined;

beforeEach(() => {
  stored = null;
  mode = {};
  writes = [];
  submitCallsAtWrite = [];
  dialogHook = undefined;
  mockDialogs.length = 0;
  mockSubmit.fail = false;
  mockSubmit.calls = 0;
  (globalThis as any).snap = {
    request: async ({ method, params }: any) => {
      if (method === 'snap_manageState') {
        if (params.operation === 'get') return mode.get ? mode.get() : stored === null ? null : JSON.parse(JSON.stringify(stored));
        if (params.operation === 'update') {
          if (mode.update) return mode.update();
          stored = JSON.parse(JSON.stringify(params.newState));
          writes.push(stored);
          submitCallsAtWrite.push(mockSubmit.calls);
          return null;
        }
      }
      if (method === 'snap_dialog') {
        if (params?.type === 'alert') {
          mockDialogs.push({ kind: 'alert', props: { type: 'alert' } });
        }
        const hook = dialogHook;
        dialogHook = undefined;
        hook?.();
        return true;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
});

const call = async (method: string, params: unknown, origin = 'https://zyronchain.com') =>
  (onRpcRequest as any)({ origin, request: { jsonrpc: '2.0', id: 1, method, params } });
const tx = (receiver: string, amountAtoms = 5) => ({
  transaction: { kind: 'transfer', version: 2, chainId: 'zyron-snap-testnet-1', nonce: 1, receiver, amountAtoms, feeAtoms: 100_000 },
});
const send = (receiver: string, amountAtoms = 5) => call('zyron_sendTransfer', { receiver, amountAtoms });
const outcome = async (p: Promise<unknown>): Promise<{ ok: boolean; v?: any; e?: string }> => {
  try {
    return { ok: true, v: await p };
  } catch (error: any) {
    return { ok: false, e: String(error?.message ?? error) };
  }
};
const transferWarnings = () => mockDialogs.filter((d) => d.kind === 'transfer').map((d) => d.props.warnings.map((w: { code: string }) => w.code));
const known = (sent: string[], thresholdAtoms: number | null = null) => ({ known: { contacts: [], sent, thresholdAtoms } });

describe('fail closed on unreadable saved state', () => {
  const corrupt: [string, () => unknown][] = [
    ['get throws', () => { throw new Error('state unavailable'); }],
    ['get returns {}', () => ({})],
    ['get returns "x"', () => 'x'],
    ['get returns []', () => []],
    ['known has an extra key', () => ({ known: { contacts: [], sent: [], thresholdAtoms: null, x: 1 } })],
    ['sent holds a non-canonical address', () => known(['ZYNAB'])],
    ['threshold is 0', () => ({ known: { contacts: [], sent: [], thresholdAtoms: 0 } })],
    ['threshold is "1"', () => ({ known: { contacts: [], sent: [], thresholdAtoms: '1' } })],
    ['sent has 201 entries', () => known(Array.from({ length: 201 }, (_, i) => `ZYN${i.toString(16).padStart(40, '0')}`))],
  ];
  for (const [label, get] of corrupt) {
    for (const method of ['zyron_signTransaction', 'zyron_sendTransfer']) {
      it(`${label}: ${method} is blocked before any dialog`, async () => {
        mode.get = get;
        const r = await outcome(method === 'zyron_sendTransfer' ? send(RECEIVER) : call(method, tx(RECEIVER)));
        expect(r.ok).toBe(false);
        expect(mockDialogs).toHaveLength(0);
        expect(mockSubmit.calls).toBe(0);
      });
    }
  }

  it('null or undefined state is a first install: the first-time warning is shown', async () => {
    mode.get = () => undefined;
    expect((await outcome(call('zyron_signTransaction', tx(RECEIVER)))).ok).toBe(true);
    expect(transferWarnings()).toEqual([expect.arrayContaining(['first-time'])]);
  });

  it('the threshold setter is blocked before its dialog when the state is unreadable', async () => {
    mode.get = () => ({});
    expect((await outcome(call('zyron_setWarningThreshold', { thresholdAtoms: 7 }))).ok).toBe(false);
    expect(mockDialogs).toHaveLength(0);
  });

  it('a failed history write after a successful submit still reports the txid and keeps the receiver unknown', async () => {
    mode.update = () => { throw new Error('write failed'); };
    const r = await outcome(send(RECEIVER));
    expect(mockSubmit.calls).toBe(1);
    expect(r.ok).toBe(true);
    expect(r.v.txid).toBe('txid');
    expect(r.v.historySaved).toBe(false);
    expect(stored).toBeNull();
    expect(mockDialogs.some((d) => d.kind === 'alert' || d.kind === 'history-failed')).toBe(true);
  });
});

describe('concurrency inside one Snap instance', () => {
  it('two transfers and a threshold change in parallel lose nothing', async () => {
    const A = `ZYN${'a1'.repeat(20)}`;
    const B = `ZYN${'b2'.repeat(20)}`;
    await Promise.all([send(A), send(B), call('zyron_setWarningThreshold', { thresholdAtoms: 9 })]);
    expect(stored.known.sent).toEqual(expect.arrayContaining([A, B]));
    expect(stored.known.thresholdAtoms).toBe(9);
  });

  it('a failed write does not jam the queue', async () => {
    mode.update = () => { throw new Error('once'); };
    await outcome(send(RECEIVER));
    mode = {};
    expect((await outcome(send(OTHER))).ok).toBe(true);
    expect(stored.known.sent).toStrictEqual([OTHER]);
  });

  it('a receiver recorded while a transfer dialog is open survives that transfer', async () => {
    dialogHook = () => { stored = known([OTHER], 150_000_000); };
    await send(RECEIVER);
    expect(stored.known.sent).toEqual(expect.arrayContaining([OTHER, RECEIVER]));
    expect(stored.known.thresholdAtoms).toBe(150_000_000);
  });
});

describe('Low-A: large-amount warning is on by default', () => {
  it('a first install uses the default threshold', () => {
    expect(emptyKnown().thresholdAtoms).toBe(DEFAULT_THRESHOLD_ATOMS);
  });

  it('a transfer at the default threshold on a first install shows the large-amount warning', async () => {
    await call('zyron_signTransaction', tx(RECEIVER, DEFAULT_THRESHOLD_ATOMS));
    await call('zyron_signTransaction', tx(RECEIVER, DEFAULT_THRESHOLD_ATOMS - 1));
    const [atDefault, below] = transferWarnings();
    expect(atDefault).toContain('large-amount');
    expect(below).not.toContain('large-amount');
  });

  it('turning the warning off still needs a confirmed dialog that says it is being disabled', async () => {
    expect(await call('zyron_setWarningThreshold', { thresholdAtoms: null })).toStrictEqual({ thresholdAtoms: null });
    expect(mockDialogs).toEqual([{ kind: 'threshold', props: { origin: 'https://zyronchain.com', thresholdAtoms: null } }]);
    expect(stored.known.thresholdAtoms).toBeNull();
    await call('zyron_signTransaction', tx(RECEIVER, 10 ** 12));
    expect(transferWarnings()[0]).not.toContain('large-amount');
  });
});

describe('Low-B: only a submitted sendTransfer records the receiver', () => {
  it('a sign-only signTransaction does not add the receiver to sent', async () => {
    await call('zyron_signTransaction', tx(RECEIVER));
    expect(writes).toHaveLength(0);
    await call('zyron_signTransaction', tx(RECEIVER));
    expect(transferWarnings()).toEqual([
      expect.arrayContaining(['first-time']),
      expect.arrayContaining(['first-time']),
    ]);
  });

  it('a failed submit does not record the receiver', async () => {
    mockSubmit.fail = true;
    expect((await outcome(send(RECEIVER))).ok).toBe(false);
    expect(writes).toHaveLength(0);
    mockSubmit.fail = false;
    await send(RECEIVER);
    expect(transferWarnings()[1]).toContain('first-time');
  });

  it('the receiver is recorded only after submitTransfer succeeds', async () => {
    const r = await send(RECEIVER);
    expect(submitCallsAtWrite).toStrictEqual([1]);
    expect(stored.known.sent).toStrictEqual([RECEIVER]);
    expect(r.historySaved).toBe(true);
    await send(RECEIVER);
    expect(transferWarnings()[1]).not.toContain('first-time');
  });
});

describe('Info: historySaved notice after a failed history write', () => {
  it('a successful history write returns historySaved true and shows no history-failed alert', async () => {
    const r = await send(RECEIVER);
    expect(r.historySaved).toBe(true);
    expect(mockDialogs.filter((d) => d.kind === 'alert' || d.kind === 'history-failed')).toHaveLength(0);
  });

  it('a failed history write returns the txid with historySaved false (never an error)', async () => {
    mode.update = () => { throw new Error('write failed'); };
    const r = await outcome(send(OTHER));
    expect(r.ok).toBe(true);
    expect(r.v.txid).toBe('txid');
    expect(r.v.historySaved).toBe(false);
    expect(mockSubmit.calls).toBe(1);
  });
});

describe('Info: one-time migration for pre-#1199 null thresholds', () => {
  it('an old null threshold without schemaVersion becomes the default on load', async () => {
    stored = known([], null); // pre-#1199 shape: no schemaVersion
    await call('zyron_signTransaction', tx(RECEIVER, DEFAULT_THRESHOLD_ATOMS));
    expect(transferWarnings()[0]).toContain('large-amount');
    expect(stored.schemaVersion).toBe(1);
    expect(stored.known.thresholdAtoms).toBe(DEFAULT_THRESHOLD_ATOMS);
  });

  it('a confirmed disable after migration keeps thresholdAtoms null', async () => {
    stored = known([], null);
    await call('zyron_signTransaction', tx(RECEIVER)); // triggers migration
    expect(stored.known.thresholdAtoms).toBe(DEFAULT_THRESHOLD_ATOMS);
    expect(await call('zyron_setWarningThreshold', { thresholdAtoms: null })).toStrictEqual({ thresholdAtoms: null });
    expect(stored.known.thresholdAtoms).toBeNull();
    expect(stored.schemaVersion).toBe(1);
    await call('zyron_signTransaction', tx(RECEIVER, 10 ** 12));
    expect(transferWarnings().at(-1)).not.toContain('large-amount');
  });

  it('corrupt state is still blocked and is not repaired by migration', async () => {
    mode.get = () => ({ known: { contacts: [], sent: [], thresholdAtoms: null, x: 1 } });
    const r = await outcome(send(RECEIVER));
    expect(r.ok).toBe(false);
    expect(mockDialogs).toHaveLength(0);
    expect(mockSubmit.calls).toBe(0);
  });

  it('an invalid schemaVersion fails closed and is not repaired', async () => {
    mode.get = () => ({ known: { contacts: [], sent: [], thresholdAtoms: null }, schemaVersion: '1' });
    const r = await outcome(call('zyron_signTransaction', tx(RECEIVER)));
    expect(r.ok).toBe(false);
    expect(mockDialogs).toHaveLength(0);
  });
});
