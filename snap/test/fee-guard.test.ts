import { describe, expect, it } from '@jest/globals';
import type { SnapAlertInterface } from '@metamask/snaps-jest';
import { installSnap } from '@metamask/snaps-jest';

import { FIXED_TRANSFER_FEE_ATOMS } from '../src/constants';
import { FIXED_SUPPLY_V1_CHAIN_IDS, fixedFeeRejection, protocolFeeEnforced } from '../src/fee-guard';
import { ORIGIN, PRIMARY, baseTransfer, renderedText } from './helpers';

const REJECTED = /This network will reject this fee\. The protocol fee is 100000 atoms \(0\.001 ZYN\)\. Nothing was signed\./u;

describe('fixed fee guard', () => {
  it('pins the published fixed-supply chain IDs and the 0.001 ZYN default', () => {
    expect(FIXED_TRANSFER_FEE_ATOMS).toBe(100_000);
    expect(FIXED_SUPPLY_V1_CHAIN_IDS).toStrictEqual([
      'zyron-open-testnet-1',
      'zyron-open-testnet-render-1',
      'zyron-public-testnet-1',
    ]);
  });

  it('rejects a different fee on a fee-policy genesis and on fixed-supply-v1 by default', () => {
    expect(fixedFeeRejection({ chainId: 'zyron-wallet-testnet-1', feeAtoms: 0, feePolicyActive: true })).toMatch(REJECTED);
    expect(protocolFeeEnforced({ chainId: 'zyron-wallet-testnet-1', feeAtoms: 0, launchProfile: 'fixed-supply-v1', feePolicyActive: false })).toBe(true);
    expect(fixedFeeRejection({ chainId: 'zyron-devnet-1', feeAtoms: 0, launchProfile: 'fixed-supply-v1' })).toMatch(REJECTED);
    expect(fixedFeeRejection({ chainId: 'zyron-devnet-1', feeAtoms: 100_000, launchProfile: 'fixed-supply-v1' })).toBeUndefined();
    expect(fixedFeeRejection({ chainId: 'zyron-devnet-1', feeAtoms: 4, feePolicyActive: true, fixedTransferFeeAtoms: 4 })).toBeUndefined();
    expect(fixedFeeRejection({ chainId: 'zyron-devnet-1', feeAtoms: 0, feePolicyActive: true, fixedTransferFeeAtoms: 4 })).toBe(
      'This network will reject this fee. The protocol fee is 4 atoms. Nothing was signed.',
    );
  });

  it('keeps caller-chosen fees on the wallet testnet and on other chains', () => {
    expect(fixedFeeRejection({ chainId: 'zyron-wallet-testnet-1', feeAtoms: 0 })).toBeUndefined();
    expect(fixedFeeRejection({ chainId: 'zyron-snap-testnet-1', feeAtoms: 1_000 })).toBeUndefined();
    expect(fixedFeeRejection({ chainId: 'zyron-open-testnet-1', feeAtoms: 0, launchProfile: 'legacy' })).toBeUndefined();
  });

  it.each(FIXED_SUPPLY_V1_CHAIN_IDS)('blocks fee 0 on %s before any signature', async (chainId) => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const pending = request({
      method: 'zyron_signTransaction',
      origin: ORIGIN,
      params: { transaction: baseTransfer({ chainId, feeAtoms: 0 }) } as any,
    });
    const ui = (await pending.getInterface()) as SnapAlertInterface;
    expect(ui.type).toBe('alert');
    const text = renderedText(ui.content);
    expect(text).toMatch(/Network will reject this fee/u);
    expect(text).toMatch(REJECTED);
    await ui.ok();
    await expect(pending).resolves.toRespondWithError(
      expect.objectContaining({ code: -32602, message: expect.stringMatching(REJECTED) }),
    );
  });

  it('signs the protocol fee on a fixed-supply chain', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const pending = request({
      method: 'zyron_signTransaction',
      origin: ORIGIN,
      params: { transaction: baseTransfer({ chainId: 'zyron-open-testnet-1', feeAtoms: FIXED_TRANSFER_FEE_ATOMS }) } as any,
    });
    const ui = (await pending.getInterface()) as SnapAlertInterface;
    expect(ui.type).toBe('confirmation');
    expect(renderedText(ui.content)).not.toMatch(/will reject this fee/u);
    await ui.ok();
    const response = (await pending) as unknown as { response: { result?: { transaction: { feeAtoms: number } } } };
    expect(response.response.result?.transaction.feeAtoms).toBe(FIXED_TRANSFER_FEE_ATOMS);
  });
});
