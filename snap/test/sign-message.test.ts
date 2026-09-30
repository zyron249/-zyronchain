import { describe, expect, it } from '@jest/globals';
import type { SnapConfirmationInterface } from '@metamask/snaps-jest';
import { installSnap } from '@metamask/snaps-jest';

import { MESSAGE_SIGNING_DOMAIN, TRANSFER_SIGNING_DOMAIN_V2 } from '../src/constants';
import { CHAIN_ID, ORIGIN, PRIMARY, RECEIVER, deriveTestPrivateKey, l1, l1Value, renderedText } from './helpers';

type MessageResult = {
  domain: string;
  payload: { message: string; origin: string };
  address: string;
  publicKey: string;
  signature: string;
};

/**
 * Signs a message with dialog approval.
 *
 * @param message - Message text.
 * @returns Result and dialog text.
 */
async function signMessage(message: string) {
  const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
  const pending = request({ method: 'zyron_signMessage', origin: ORIGIN, params: { message } });
  const ui = (await pending.getInterface()) as SnapConfirmationInterface;
  const text = renderedText(ui.content);
  await ui.ok();
  const response = (await pending) as unknown as { response: Record<string, unknown> };
  const result = (response.response as { result?: MessageResult }).result;
  if (!result) {
    throw new Error(JSON.stringify(response.response));
  }
  return { result, text };
}

describe('zyron_signMessage', () => {
  it('signs origin-bound messages that verify with l1 verifyCanonicalDomain', async () => {
    const { result, text } = await signMessage('Log in to zyronchain.com\nnonce: 42');
    expect(text).toContain('Log in to zyronchain.com');
    expect(text).toContain(ORIGIN);
    expect(result.domain).toBe(MESSAGE_SIGNING_DOMAIN);
    expect(result.payload).toEqual({ message: 'Log in to zyronchain.com\nnonce: 42', origin: ORIGIN });
    expect(result.address).toBe(PRIMARY.address);
    expect(
      l1Value({ op: 'verifyCanonicalDomain', domain: MESSAGE_SIGNING_DOMAIN, payload: result.payload, signature: result.signature, publicKey: result.publicKey }),
    ).toBe(true);
    // Bound to the origin: the same text from another origin does not verify.
    expect(
      l1Value({ op: 'verifyCanonicalDomain', domain: MESSAGE_SIGNING_DOMAIN, payload: { ...result.payload, origin: 'https://evil.example' }, signature: result.signature, publicKey: result.publicKey }),
    ).toBe(false);
    expect(JSON.stringify(result)).not.toContain(await deriveTestPrivateKey(PRIMARY.mnemonic));
  });

  it('domain separation: a message signature can never be used as an l1 transaction signature', async () => {
    const constants = l1Value<{ transactionSigningDomains: string[] }>({ op: 'constants' });
    expect(constants.transactionSigningDomains).toContain(TRANSFER_SIGNING_DOMAIN_V2);
    expect(constants.transactionSigningDomains).not.toContain(MESSAGE_SIGNING_DOMAIN);

    for (const version of [1, 2]) {
      // Attack: ask for a "message" whose text is exactly the canonical transfer payload.
      const unsigned = {
        amountAtoms: 150_000_000,
        chainId: CHAIN_ID,
        feeAtoms: 1_000,
        kind: 'transfer',
        nonce: 1,
        publicKey: PRIMARY.publicKey,
        receiver: RECEIVER,
        sender: PRIMARY.address,
        timestampMs: 1_700_000_000_500,
        version,
      };
      const canonical = JSON.stringify(unsigned); // keys already sorted = l1 canonicalJson
      const { result } = await signMessage(canonical);

      const forged = { ...unsigned, signature: result.signature };
      const txid = l1Value<string>({ op: 'txid', payload: forged });
      const validation = l1({ op: 'validateTransaction', tx: { ...forged, txid } });
      expect(validation).toStrictEqual({ ok: false, error: 'Invalid transaction signature' });

      // Neither the v1 (undomained) nor the v2 (transfer-domain) verifier accepts it.
      expect(l1Value({ op: 'verifyCanonical', payload: unsigned, signature: result.signature, publicKey: PRIMARY.publicKey })).toBe(false);
      expect(
        l1Value({ op: 'verifyCanonicalDomain', domain: TRANSFER_SIGNING_DOMAIN_V2, payload: unsigned, signature: result.signature, publicKey: PRIMARY.publicKey }),
      ).toBe(false);
      // Nor is a message signature valid over the message payload without its domain.
      expect(l1Value({ op: 'verifyCanonical', payload: result.payload, signature: result.signature, publicKey: PRIMARY.publicKey })).toBe(false);
    }
  });

  it('returns 4001 when the user declines', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const pending = request({ method: 'zyron_signMessage', origin: ORIGIN, params: { message: 'hi' } });
    const ui = (await pending.getInterface()) as SnapConfirmationInterface;
    await ui.cancel();
    expect(await pending).toRespondWithError(expect.objectContaining({ code: 4001 }));
  });

  it.each([
    ['empty', { message: '' }],
    ['too long', { message: 'x'.repeat(1025) }],
    ['not a string', { message: 42 }],
    ['control characters', { message: 'a\u0000b' }],
    ['bidi override', { message: 'pay \u202eNYZ 1' }],
    ['extra field', { message: 'hi', domain: 'zyronchain/transaction/transfer/v2' }],
  ])('rejects invalid messages (%s)', async (_label, params) => {
    const { request } = await installSnap();
    const response = await request({ method: 'zyron_signMessage', origin: ORIGIN, params: params as any });
    expect(response).toRespondWithError(expect.objectContaining({ code: -32602 }));
  });
});
