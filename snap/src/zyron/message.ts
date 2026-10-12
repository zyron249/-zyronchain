/**
 * Off-chain message signing with a domain that can never be confused with an
 * l1 transaction signature. See README "Message signing and domain separation".
 */
import { MAX_MESSAGE_LENGTH, MESSAGE_SIGNING_DOMAIN } from '../constants';
import { signCanonicalDomain } from './crypto';
import { TransactionRequestError, assertPlainRecord } from './transfer';

export type MessagePayload = { message: string; origin: string };

// C0/C1 controls (except \t and \n) and bidi override/isolate characters that
// could make the dialog render something different from what is signed.
const FORBIDDEN_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

/**
 * Validates `zyron_signMessage` params and binds the requesting origin.
 *
 * @param params - Untrusted params.
 * @param origin - Requesting origin (from MetaMask, not from the dapp).
 * @returns The payload to sign.
 */
export function parseMessageRequest(params: unknown, origin: string): MessagePayload {
  assertPlainRecord(params, 'params');
  const keys = Object.keys(params);
  if (keys.length !== 1 || keys[0] !== 'message') {
    throw new TransactionRequestError('zyron_signMessage params must be exactly { message }');
  }
  const { message } = params;
  if (typeof message !== 'string' || message.length === 0 || message.length > MAX_MESSAGE_LENGTH) {
    throw new TransactionRequestError(
      `Invalid message: must be a non-empty string of at most ${MAX_MESSAGE_LENGTH} characters`,
    );
  }
  if (FORBIDDEN_CHARACTERS.test(message)) {
    throw new TransactionRequestError('Invalid message: control or bidirectional-override characters are not allowed');
  }
  return { message, origin };
}

/**
 * Signs canonicalJson({ domain: MESSAGE_SIGNING_DOMAIN, payload: { message, origin } }).
 *
 * @param payload - Validated payload.
 * @param privateKey - Secret key bytes.
 * @returns Compact signature hex.
 */
export function signMessagePayload(payload: MessagePayload, privateKey: Uint8Array): string {
  return signCanonicalDomain(MESSAGE_SIGNING_DOMAIN, payload, privateKey);
}
