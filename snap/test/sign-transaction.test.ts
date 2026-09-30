import { describe, expect, it } from '@jest/globals';
import type { SnapConfirmationInterface } from '@metamask/snaps-jest';
import { installSnap } from '@metamask/snaps-jest';

import { MAX_SUPPLY_ATOMS, MINING_TRACKER_ADDRESS } from '../src/constants';
import {
  CHAIN_ID,
  ORIGIN,
  PRIMARY,
  RECEIVER,
  baseTransfer,
  deriveTestPrivateKey,
  l1,
  l1Value,
  renderedText,
} from './helpers';

type SignedTx = Record<string, unknown> & { signature: string; txid: string; sender: string };

/**
 * Sends zyron_signTransaction, approves the dialog, returns the signed tx.
 *
 * @param transaction - Request transaction.
 * @returns Signed tx and rendered dialog text.
 */
async function signApproved(transaction: Record<string, unknown>) {
  const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
  const pending = request({ method: 'zyron_signTransaction', origin: ORIGIN, params: { transaction } as any });
  const ui = (await pending.getInterface()) as SnapConfirmationInterface;
  expect(ui.type).toBe('confirmation');
  const text = renderedText(ui.content);
  await ui.ok();
  const response = (await pending) as unknown as { response: Record<string, unknown> };
  const result = (response.response as { result?: { transaction: SignedTx } }).result;
  if (!result) {
    throw new Error(`signing failed: ${JSON.stringify(response.response)}`);
  }
  return { tx: result.transaction, text, response };
}

/**
 * Expects an invalid-params rejection without any dialog being shown.
 *
 * @param transaction - Request transaction.
 * @param message - Expected error message pattern.
 */
async function expectRejected(transaction: unknown, message: RegExp) {
  const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
  const response = await request({
    method: 'zyron_signTransaction',
    origin: ORIGIN,
    params: { transaction } as any,
  });
  expect(response).toRespondWithError(expect.objectContaining({ code: -32602, message: expect.stringMatching(message) }));
}

describe('zyron_signTransaction', () => {
  it.each([
    [2, 3],
    [1, 1],
  ])('v%i transfer: dialog shows the details; l1 verifies, validates and includes it (protocol %i)', async (version, protocolVersion) => {
    const { tx, text } = await signApproved(baseTransfer({ version }));

    // Dialog content: recipient, amount in ZYN, fee, chainId.
    expect(text).toContain(RECEIVER);
    expect(text).toContain('1.5 ZYN');
    expect(text).toContain('0.00001 ZYN');
    expect(text).toContain(CHAIN_ID);
    expect(text).toContain(PRIMARY.address);

    // Exactly the l1 TransferTx shape.
    expect(Object.keys(tx).sort()).toStrictEqual(
      ['amountAtoms', 'chainId', 'feeAtoms', 'kind', 'nonce', 'publicKey', 'receiver', 'sender', 'signature', 'timestampMs', 'txid', 'version'].sort(),
    );
    expect(tx.sender).toBe(PRIMARY.address);
    expect(tx.publicKey).toBe(PRIMARY.publicKey);

    // l1 validateTransactionShape (signature, txid, address/public key binding).
    expect(l1({ op: 'validateTransaction', tx })).toStrictEqual({ ok: true, value: true });

    // Byte-identical to l1 createTransfer with the same key (RFC 6979 is deterministic).
    const privateKey = await deriveTestPrivateKey(PRIMARY.mnemonic);
    const { signature: _s, txid: _t, kind: _k, version: _v, publicKey: _p, ...input } = tx;
    const expected = l1Value<SignedTx>({ op: 'createTransfer', privateKey, input, version });
    expect(JSON.stringify(tx)).toBe(JSON.stringify(expected));

    // Full l1 chain: mempool admission + block production/acceptance.
    const accepted = l1Value<{ protocolVersion: number; senderNonce: number; receiverDelta: number }>({
      op: 'chainAccept',
      tx,
      fundedAddress: PRIMARY.address,
      fundingAtoms: 10 * 100_000_000,
      chainId: CHAIN_ID,
      protocolVersion,
    });
    expect(accepted).toStrictEqual(expect.objectContaining({ protocolVersion, senderNonce: 1, receiverDelta: 150_000_000 }));

    expect(JSON.stringify(tx)).not.toContain(privateKey);
  });

  it('a transfer signed for one chain ID is rejected by an l1 chain with another ID', async () => {
    const { tx } = await signApproved(baseTransfer({ version: 1 }));
    const result = l1({
      op: 'chainAccept',
      tx,
      fundedAddress: PRIMARY.address,
      fundingAtoms: 10 * 100_000_000,
      chainId: 'zyron-other-chain',
      protocolVersion: 1,
    });
    expect(result).toStrictEqual({ ok: false, error: 'Wrong transaction chain ID' });
  });

  it('fills timestampMs when omitted and accepts matching sender/publicKey', async () => {
    const { timestampMs: _omit, ...rest } = baseTransfer();
    const before = Date.now();
    const { tx } = await signApproved({ ...rest, sender: PRIMARY.address, publicKey: PRIMARY.publicKey });
    expect(tx.timestampMs).toBeGreaterThanOrEqual(before);
    expect(l1({ op: 'validateTransaction', tx })).toStrictEqual({ ok: true, value: true });
  });

  it('returns 4001 and no signature when the user declines', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const pending = request({ method: 'zyron_signTransaction', origin: ORIGIN, params: { transaction: baseTransfer() } });
    const ui = (await pending.getInterface()) as SnapConfirmationInterface;
    await ui.cancel();
    const response = await pending;
    expect(response).toRespondWithError(expect.objectContaining({ code: 4001 }));
    expect(JSON.stringify(response)).not.toMatch(/signature|txid/u);
  });

  it('blocks mining_claim entirely (no dialog, no signature)', async () => {
    await expectRejected(
      {
        kind: 'mining_claim',
        version: 2,
        chainId: CHAIN_ID,
        nonce: 1,
        height: 1,
        previousHash: '00'.repeat(32),
        rewardAtoms: 1,
        workNonce: '0'.repeat(16),
        timestampMs: 1,
      },
      /mining_claim is blocked/u,
    );
    await expectRejected({ ...baseTransfer(), kind: 'mining_claim' }, /mining_claim is blocked/u);
  });

  it.each(['validator_update', 'protocol_upgrade', 'activity_settlement'])('rejects %s (transfers only)', async (kind) => {
    await expectRejected({ ...baseTransfer(), kind }, /only signs transfers/u);
  });

  it('rejects unknown kinds', async () => {
    await expectRejected({ ...baseTransfer(), kind: 'mint' }, /Unknown transaction kind/u);
  });

  it.each([
    ['uppercase', 'Zyron-Test'],
    ['too short', 'zy'],
    ['too long', 'z'.repeat(65)],
    ['spaces', 'zyron test'],
    ['number', 1],
    ['null', null],
  ])('rejects a bad chainId (%s)', async (_label, chainId) => {
    await expectRejected(baseTransfer({ chainId }), /Invalid chainId/u);
  });

  it('rejects a missing chainId', async () => {
    const { chainId: _omit, ...rest } = baseTransfer();
    await expectRejected(rest, /Missing transaction field "chainId"/u);
  });

  it.each([
    ['amount above supply', { amountAtoms: MAX_SUPPLY_ATOMS + 1 }, /Invalid amountAtoms/u],
    ['amount 2^53', { amountAtoms: 2 ** 53 }, /Invalid amountAtoms/u],
    ['amount 1e21', { amountAtoms: 1e21 }, /Invalid amountAtoms/u],
    ['amount as string', { amountAtoms: '100' }, /Invalid amountAtoms/u],
    ['amount negative', { amountAtoms: -1 }, /Invalid amountAtoms/u],
    ['amount fractional', { amountAtoms: 1.5 }, /Invalid amountAtoms/u],
    ['amount zero', { amountAtoms: 0 }, /must be positive/u],
    ['fee above supply', { feeAtoms: MAX_SUPPLY_ATOMS + 1 }, /Invalid feeAtoms/u],
    ['fee negative', { feeAtoms: -1 }, /Invalid feeAtoms/u],
    ['amount + fee above supply', { amountAtoms: MAX_SUPPLY_ATOMS, feeAtoms: 1 }, /exceeds the 50M ZYN supply/u],
  ])('rejects overflow / malformed amounts (%s)', async (_label, overrides, message) => {
    await expectRejected(baseTransfer(overrides), message);
  });

  it.each([
    ['unknown field', { memo: 'hi' }, /Unknown transaction field "memo"/u],
    ['pre-set signature', { signature: '00'.repeat(64) }, /Unknown transaction field "signature"/u],
    ['pre-set txid', { txid: '00'.repeat(32) }, /Unknown transaction field "txid"/u],
    ['foreign sender', { sender: RECEIVER }, /sender does not match/u],
    ['foreign publicKey', { publicKey: 'aa'.repeat(64) }, /publicKey does not match/u],
    ['receiver malformed', { receiver: '0x1234' }, /Invalid receiver/u],
    ['receiver uppercase hex', { receiver: `ZYN${'AB'.repeat(20)}` }, /Invalid receiver/u],
    ['receiver is mining tracker', { receiver: MINING_TRACKER_ADDRESS }, /mining tracker/u],
    ['nonce zero', { nonce: 0 }, /Invalid nonce/u],
    ['nonce unsafe', { nonce: 2 ** 53 }, /Invalid nonce/u],
    ['version 3', { version: 3 }, /Invalid version/u],
    ['timestamp negative', { timestampMs: -1 }, /Invalid timestampMs/u],
  ])('rejects malformed fields (%s)', async (_label, overrides, message) => {
    await expectRejected(baseTransfer(overrides), message);
  });

  it('rejects non-object transactions and extra top-level params', async () => {
    await expectRejected('transfer', /Invalid transaction/u);
    await expectRejected([baseTransfer()], /Invalid transaction/u);
    const { request } = await installSnap();
    const response = await request({
      method: 'zyron_signTransaction',
      origin: ORIGIN,
      params: { transaction: baseTransfer(), broadcast: true },
    });
    expect(response).toRespondWithError(expect.objectContaining({ code: -32602 }));
  });
});
