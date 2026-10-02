/**
 * Key derivation. The secret key is obtained from MetaMask with
 * `snap_getBip32Entropy` for exactly DERIVATION_PATH, used in memory, and
 * zeroised (best effort) after use. It is never returned, logged or stored.
 */
import { hexToBytes } from '@noble/hashes/utils.js';

import { DERIVATION_PATH } from './constants';
import { addressFromPublicKey, publicKeyFromPrivate } from './zyron/crypto';

export type Account = { address: string; publicKey: string };

/**
 * Runs `use` with the derived secret key, then wipes the key bytes.
 *
 * @param use - Callback receiving the key and public account data.
 * @returns The callback's result.
 */
export async function withAccountKey<Result>(
  use: (privateKey: Uint8Array, account: Account) => Result | Promise<Result>,
): Promise<Result> {
  const node = await snap.request({
    method: 'snap_getBip32Entropy',
    params: { path: [...DERIVATION_PATH], curve: 'secp256k1' },
  });
  if (!node.privateKey || !/^0x[0-9a-f]{64}$/u.test(node.privateKey)) {
    throw new Error('MetaMask did not return a usable secp256k1 key');
  }
  const privateKey = hexToBytes(node.privateKey.slice(2));
  try {
    const publicKey = publicKeyFromPrivate(privateKey);
    // Cross-check against the public key MetaMask derived for the same node.
    if (node.publicKey.toLowerCase() !== `0x04${publicKey}`) {
      throw new Error('Derived public key mismatch');
    }
    return await use(privateKey, { address: addressFromPublicKey(publicKey), publicKey });
  } finally {
    privateKey.fill(0);
  }
}

/**
 * Public account data only.
 *
 * @returns The Snap's ZyronChain address and public key.
 */
export async function getAccount(): Promise<Account> {
  return withAccountKey((_privateKey, account) => account);
}
