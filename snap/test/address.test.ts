import { describe, expect, it } from '@jest/globals';
import { installSnap } from '@metamask/snaps-jest';

import { DERIVATION_PATH_STRING } from '../src/constants';
import { DEV_ORIGIN, ORIGIN, VECTORS, deriveTestPrivateKey, l1Value } from './helpers';

describe('zyron_getAddress', () => {
  it.each(VECTORS)('matches the fixed vector and the real l1 derivation ($address)', async (vector) => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: vector.mnemonic } });
    const response = await request({ method: 'zyron_getAddress', origin: ORIGIN });
    expect(response).toRespondWith({
      address: vector.address,
      publicKey: vector.publicKey,
      derivationPath: DERIVATION_PATH_STRING,
    });

    // Independently derive the key and run l1's own publicKeyFromPrivate/addressFromPublicKey.
    const privateKey = await deriveTestPrivateKey(vector.mnemonic);
    const fromL1 = l1Value<{ publicKey: string; address: string }>({ op: 'address', privateKey });
    expect(fromL1).toStrictEqual({ publicKey: vector.publicKey, address: vector.address });

    // The secret key never appears in the response.
    expect(JSON.stringify(response)).not.toContain(privateKey);
  });

  it('uses the documented derivation path m/44\'/249249\'/0\'/0/0', () => {
    expect(DERIVATION_PATH_STRING).toBe("m/44'/249249'/0'/0/0");
  });

  it('is available to the localhost dev origin', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: VECTORS[0]!.mnemonic } });
    const response = await request({ method: 'zyron_getAddress', origin: DEV_ORIGIN });
    expect(response).toRespondWith(expect.objectContaining({ address: VECTORS[0]!.address }));
  });

  it('rejects origins that are not allow-listed', async () => {
    const { request } = await installSnap();
    const response = await request({ method: 'zyron_getAddress', origin: 'https://evil.example' });
    expect(response).toRespondWithError(
      expect.objectContaining({ message: expect.stringMatching(/not allowed|not permitted|Unauthorized/iu) }),
    );
  });

  it('rejects parameters', async () => {
    const { request } = await installSnap();
    const response = await request({ method: 'zyron_getAddress', origin: ORIGIN, params: { index: 1 } });
    expect(response).toRespondWithError(expect.objectContaining({ code: -32602 }));
  });

  it('rejects unknown methods', async () => {
    const { request } = await installSnap();
    const response = await request({ method: 'eth_sendTransaction', origin: ORIGIN });
    expect(response).toRespondWithError(expect.objectContaining({ code: -32601 }));
  });
});
