/**
 * End-to-end test against a live ZyronChain wallet TESTNET RPC (no value).
 *
 * Runs only when ZYRON_E2E_RPC_URL is set, and the Snap bundle must have been
 * built with the same ZYRON_TESTNET_RPC_URL. In CI the RPC is the real
 * l1/scripts/public-testnet-rpc.mjs (one canonical L1 validator) on loopback.
 */
import { describe, expect, it } from '@jest/globals';
import type { SnapConfirmationInterface } from '@metamask/snaps-jest';
import { installSnap } from '@metamask/snaps-jest';

import { TESTNET_CHAIN_ID } from '../src/constants';
import { ORIGIN, PRIMARY, VECTORS, renderedText } from './helpers';

const RPC = process.env.ZYRON_E2E_RPC_URL?.replace(/\/+$/u, '');
const ZYN = 100_000_000;
const describeE2E = RPC ? describe : describe.skip;

type Account = { balanceAtoms: number; nonce: number };

async function rpcAccount(address: string): Promise<Account> {
  const response = await fetch(`${RPC}/account/${address}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Account;
}

async function waitFor<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 150_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describeE2E('wallet testnet end to end (live RPC)', () => {
  const sender = PRIMARY.address;
  const receiver = VECTORS[1]!.address;

  it('derives the phone-wallet address, reads its balance, and sends a finalized test transfer', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });

    const addressResponse = (await request({ method: 'zyron_getAddress', origin: ORIGIN })) as any;
    expect(addressResponse.response.result.address).toBe(sender);
    expect(addressResponse.response.result.derivationPath).toBe("m/44'/249249'/0'/0/0");

    // Fund the Snap account from the testnet faucet (once per address per day).
    const faucet = await fetch(`${RPC}/faucet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: sender }),
    });
    expect([200, 429]).toContain(faucet.status);
    const funded = await waitFor('faucet funds', async () => {
      const balance = (await request({ method: 'zyron_getBalance', origin: ORIGIN })) as any;
      const result = balance.response.result;
      return result && result.balanceAtoms >= 20 * ZYN ? result : undefined;
    });
    expect(funded).toStrictEqual(
      expect.objectContaining({ network: 'testnet', valueBearing: false, chainId: TESTNET_CHAIN_ID, address: sender }),
    );

    const before = { sender: await rpcAccount(sender), receiver: await rpcAccount(receiver) };
    const amountAtoms = 12 * ZYN + 50_000_000;
    const pending = request({
      method: 'zyron_sendTransfer',
      origin: ORIGIN,
      params: { receiver, amountAtoms, feeAtoms: 0 },
    });
    const ui = (await pending.getInterface()) as SnapConfirmationInterface;
    const text = renderedText(ui.content);
    expect(text).toContain('Send testnet ZYN');
    expect(text).toContain(receiver);
    expect(text).toContain('12.5 ZYN');
    expect(text).toContain(TESTNET_CHAIN_ID);
    await ui.ok();
    const sent = ((await pending) as any).response.result;
    expect(sent).toStrictEqual(expect.objectContaining({ network: 'testnet', chainId: TESTNET_CHAIN_ID }));
    expect(sent.txid).toMatch(/^[0-9a-f]{64}$/u);
    expect(sent.transaction.nonce).toBe(before.sender.nonce + 1);

    const after = await waitFor('finalized transfer', async () => {
      const state = await rpcAccount(receiver);
      return state.balanceAtoms === before.receiver.balanceAtoms + amountAtoms ? state : undefined;
    });
    expect(after.balanceAtoms).toBe(before.receiver.balanceAtoms + amountAtoms);
    const senderAfter = await rpcAccount(sender);
    expect(senderAfter.balanceAtoms).toBe(before.sender.balanceAtoms - amountAtoms);
    expect(senderAfter.nonce).toBe(before.sender.nonce + 1);
    // Evidence for the PR / report.
    console.log(JSON.stringify({ rpc: RPC, sender, receiver, txid: sent.txid, before, after: { sender: senderAfter, receiver: after } }));
  }, 300_000);

  it('declining the dialog returns 4001 and submits nothing', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const before = await rpcAccount(sender);
    const pending = request({ method: 'zyron_sendTransfer', origin: ORIGIN, params: { receiver, amountAtoms: ZYN } });
    const ui = (await pending.getInterface()) as SnapConfirmationInterface;
    await ui.cancel();
    expect(await pending).toRespondWithError(expect.objectContaining({ code: 4001 }));
    expect((await rpcAccount(sender)).nonce).toBe(before.nonce);
  }, 120_000);

  it('refuses an amount above the testnet balance before any dialog', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: VECTORS[1]!.mnemonic } });
    const state = await rpcAccount(receiver);
    const response = await request({
      method: 'zyron_sendTransfer',
      origin: ORIGIN,
      params: { receiver: sender, amountAtoms: state.balanceAtoms + 1 },
    });
    expect(response).toRespondWithError(
      expect.objectContaining({ code: -32602, message: expect.stringMatching(/Insufficient testnet balance/u) }),
    );
  }, 120_000);

  it('rejects unknown sendTransfer fields', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const response = await request({
      method: 'zyron_sendTransfer',
      origin: ORIGIN,
      params: { receiver, amountAtoms: ZYN, chainId: 'zyron-mainnet-1' },
    });
    expect(response).toRespondWithError(expect.objectContaining({ code: -32602 }));
  });
});
