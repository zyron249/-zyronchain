import { SLIP10Node } from '@metamask/key-tree';
import { execFileSync } from 'child_process';
import { resolve } from 'path';

import { DERIVATION_PATH } from '../src/constants';
import vectorsFile from './vectors.json';

export const ORIGIN = 'https://zyronchain.com';
export const DEV_ORIGIN = 'http://localhost:8000';
export const VECTORS = vectorsFile.vectors;
export const PRIMARY = VECTORS[0]!;
export const RECEIVER = `ZYN${'ab'.repeat(20)}`;
export const CHAIN_ID = 'zyron-snap-test-1';

type OracleResponse<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Runs the real l1 implementation (l1/dist) in a child process.
 *
 * @param request - Oracle request.
 * @returns Oracle response.
 */
export function l1<T = unknown>(request: Record<string, unknown>): OracleResponse<T> {
  const output = execFileSync(process.execPath, [resolve(__dirname, 'l1-oracle.mjs')], {
    input: JSON.stringify(request),
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(output.toString('utf8')) as OracleResponse<T>;
}

/**
 * Like {@link l1} but throws on oracle failure.
 *
 * @param request - Oracle request.
 * @returns Value.
 */
export function l1Value<T = unknown>(request: Record<string, unknown>): T {
  const response = l1<T>(request);
  if (!response.ok) {
    throw new Error(`l1 oracle failed: ${response.error}`);
  }
  return response.value;
}

/**
 * TEST ONLY: independently derive the Snap key for a public test mnemonic with
 * @metamask/key-tree so results can be compared with l1.
 *
 * @param mnemonic - Public BIP-39 test mnemonic.
 * @returns Private key hex (no 0x).
 */
export async function deriveTestPrivateKey(mnemonic: string): Promise<string> {
  const node = await SLIP10Node.fromDerivationPath({
    curve: 'secp256k1',
    derivationPath: [
      `bip39:${mnemonic}`,
      ...DERIVATION_PATH.slice(1).map((segment) => `bip32:${segment}` as `bip32:${string}`),
    ] as any,
  });
  if (!node.privateKey) {
    throw new Error('no private key');
  }
  return node.privateKey.slice(2);
}

/**
 * Collects every string rendered in a Snap UI tree.
 *
 * @param node - JSX node (JSON form).
 * @returns Concatenated text.
 */
export function renderedText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(renderedText).join(' ');
  }
  if (typeof node === 'object') {
    const { props } = node as { props?: Record<string, unknown> };
    if (!props) {
      return '';
    }
    return Object.entries(props)
      .map(([key, value]) =>
        key === 'children' || typeof value === 'object' ? renderedText(value) : typeof value === 'string' ? value : '',
      )
      .join(' ');
  }
  return '';
}

export const baseTransfer = (overrides: Record<string, unknown> = {}) => ({
  kind: 'transfer',
  version: 2,
  chainId: CHAIN_ID,
  nonce: 1,
  receiver: RECEIVER,
  amountAtoms: 150_000_000,
  feeAtoms: 1_000,
  timestampMs: 1_700_000_000_500,
  ...overrides,
});
