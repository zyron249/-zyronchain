/**
 * Validation and construction of canonical l1 `transfer` transactions.
 *
 * The produced object is exactly l1's `TransferTx` (see l1/src/types.ts and
 * `createTransfer` in l1/src/transaction.ts): same keys, same signing payload,
 * same domain for version 2, same txid rule. The validation below mirrors l1
 * `validateTransactionShape` for transfers and is deliberately stricter where
 * a wallet should be (exact field set, chain ID format, supply-bounded sums).
 */
import {
  ADDRESS_PATTERN,
  ATOMS_PER_ZYN,
  CHAIN_ID_PATTERN,
  MAX_SUPPLY_ATOMS,
  MINING_TRACKER_ADDRESS,
  TRANSFER_SIGNING_DOMAIN_V2,
} from '../constants';
import { canonicalJson, sha256Hex } from './codec';
import { signCanonical, signCanonicalDomain, verifyCanonical, verifyCanonicalDomain } from './crypto';

export type TransactionVersion = 1 | 2;

export type UnsignedTransfer = {
  kind: 'transfer';
  version: TransactionVersion;
  chainId: string;
  nonce: number;
  sender: string;
  receiver: string;
  amountAtoms: number;
  feeAtoms: number;
  timestampMs: number;
  publicKey: string;
};

export type TransferTx = UnsignedTransfer & {
  signature: string;
  txid: string;
};

export class TransactionRequestError extends Error {}

/** Every l1 transaction kind; only `transfer` is signable here. */
const KNOWN_KINDS = new Set([
  'transfer',
  'activity_settlement',
  'mining_claim',
  'validator_update',
  'protocol_upgrade',
]);

const REQUIRED_FIELDS = [
  'kind',
  'version',
  'chainId',
  'nonce',
  'receiver',
  'amountAtoms',
  'feeAtoms',
] as const;
/** Optional: `timestampMs` defaults to now; `sender`/`publicKey` must match the Snap key. */
const OPTIONAL_FIELDS = ['timestampMs', 'sender', 'publicKey'] as const;
const ALLOWED_FIELDS = new Set<string>([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]);

/**
 * Plain-object check equivalent to l1 `assertPlainRecord`.
 *
 * @param value - Value.
 * @param name - Name for errors.
 */
export function assertPlainRecord(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TransactionRequestError(`Invalid ${name}: expected an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TransactionRequestError(`Invalid ${name} prototype`);
  }
}

/**
 * Atom amount check equivalent to l1 `assertAmount`.
 *
 * @param value - Amount.
 * @param name - Field name.
 * @param allowZero - Whether zero is allowed.
 */
function assertAmount(value: unknown, name: string, allowZero: boolean): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SUPPLY_ATOMS
  ) {
    throw new TransactionRequestError(
      `Invalid ${name}: must be an integer number of atoms between ${allowZero ? 0 : 1} and ${MAX_SUPPLY_ATOMS}`,
    );
  }
  if (!allowZero && value === 0) {
    throw new TransactionRequestError(`Invalid ${name}: must be positive`);
  }
}

/**
 * Validates an untrusted transfer request and binds it to the Snap key.
 *
 * @param input - Untrusted `params.transaction` from the dapp.
 * @param signer - The Snap's derived address and public key.
 * @param signer.address - Snap address.
 * @param signer.publicKey - Snap public key hex.
 * @param nowMs - Clock used when `timestampMs` is omitted.
 * @returns A canonical unsigned transfer.
 */
export function parseTransferRequest(
  input: unknown,
  signer: { address: string; publicKey: string },
  nowMs: number,
): UnsignedTransfer {
  assertPlainRecord(input, 'transaction');

  const { kind } = input;
  if (kind === 'mining_claim') {
    throw new TransactionRequestError(
      'mining_claim is blocked: ZyronChain mining is retired and this Snap never signs mining claims',
    );
  }
  if (typeof kind !== 'string' || !KNOWN_KINDS.has(kind)) {
    throw new TransactionRequestError('Unknown transaction kind');
  }
  if (kind !== 'transfer') {
    throw new TransactionRequestError(
      `Unsupported transaction kind "${kind}": this Snap only signs transfers`,
    );
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new TransactionRequestError(`Unknown transaction field "${key}"`);
    }
  }
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(input, key)) {
      throw new TransactionRequestError(`Missing transaction field "${key}"`);
    }
  }

  const { version, chainId, nonce, receiver, amountAtoms, feeAtoms } = input;
  if (version !== 1 && version !== 2) {
    throw new TransactionRequestError('Invalid version: must be 1 or 2 (protocol >= 3 requires 2)');
  }
  if (typeof chainId !== 'string' || !CHAIN_ID_PATTERN.test(chainId)) {
    throw new TransactionRequestError(
      'Invalid chainId: must match ^[a-z0-9-]{3,64}$ (l1 genesis rule)',
    );
  }
  if (typeof nonce !== 'number' || !Number.isSafeInteger(nonce) || nonce < 1) {
    throw new TransactionRequestError('Invalid nonce: must be a safe integer >= 1');
  }
  if (typeof receiver !== 'string' || !ADDRESS_PATTERN.test(receiver)) {
    throw new TransactionRequestError('Invalid receiver address');
  }
  if (receiver === MINING_TRACKER_ADDRESS) {
    throw new TransactionRequestError('Receiver is the protocol-reserved mining tracker address');
  }
  assertAmount(amountAtoms, 'amountAtoms', false);
  assertAmount(feeAtoms, 'feeAtoms', true);
  const total = amountAtoms + feeAtoms;
  if (!Number.isSafeInteger(total) || total > MAX_SUPPLY_ATOMS) {
    throw new TransactionRequestError('Invalid amount: amountAtoms + feeAtoms exceeds the 50M ZYN supply');
  }

  let timestampMs: number = nowMs;
  if (Object.hasOwn(input, 'timestampMs')) {
    const value = input.timestampMs;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new TransactionRequestError('Invalid timestampMs: must be a safe integer >= 0');
    }
    timestampMs = value;
  }
  if (Object.hasOwn(input, 'sender') && input.sender !== signer.address) {
    throw new TransactionRequestError('sender does not match this Snap account');
  }
  if (Object.hasOwn(input, 'publicKey') && input.publicKey !== signer.publicKey) {
    throw new TransactionRequestError('publicKey does not match this Snap account');
  }
  if (signer.address === MINING_TRACKER_ADDRESS) {
    throw new TransactionRequestError('Sender is the protocol-reserved mining tracker address');
  }

  // Same key order as l1 createTransfer (canonicalJson sorts anyway).
  return {
    kind: 'transfer',
    version,
    chainId,
    nonce,
    sender: signer.address,
    receiver,
    amountAtoms,
    feeAtoms,
    timestampMs,
    publicKey: signer.publicKey,
  };
}

/**
 * l1 `createTransfer` signing step: v1 signs canonicalJson(payload); v2 signs
 * canonicalJson({ domain: "zyronchain/transaction/transfer/v2", payload }).
 * txid = sha256(canonicalJson(payload + signature)).
 *
 * @param unsigned - Validated unsigned transfer.
 * @param privateKey - Secret key bytes (never leaves the Snap).
 * @returns The signed l1 TransferTx.
 */
export function signTransfer(unsigned: UnsignedTransfer, privateKey: Uint8Array): TransferTx {
  const signature =
    unsigned.version === 2
      ? signCanonicalDomain(TRANSFER_SIGNING_DOMAIN_V2, unsigned, privateKey)
      : signCanonical(unsigned, privateKey);
  const valid =
    unsigned.version === 2
      ? verifyCanonicalDomain(TRANSFER_SIGNING_DOMAIN_V2, unsigned, signature, unsigned.publicKey)
      : verifyCanonical(unsigned, signature, unsigned.publicKey);
  if (!valid) {
    throw new Error('Internal error: produced signature failed self-verification');
  }
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) };
}

/**
 * Formats integer atoms as an exact decimal ZYN string (8 decimals max).
 *
 * @param atoms - Safe integer atoms (<= MAX_SUPPLY_ATOMS).
 * @returns For example "1.5".
 */
export function formatZyn(atoms: number): string {
  const whole = Math.floor(atoms / ATOMS_PER_ZYN);
  const fraction = (atoms % ATOMS_PER_ZYN).toString().padStart(8, '0').replace(/0+$/u, '');
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
  return fraction ? `${wholeText}.${fraction}` : wholeText;
}
