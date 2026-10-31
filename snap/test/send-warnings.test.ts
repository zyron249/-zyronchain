import { describe, expect, it, jest } from '@jest/globals';
import type { SnapConfirmationInterface } from '@metamask/snaps-jest';
import { installSnap } from '@metamask/snaps-jest';

import * as sw from '../src/send-warnings';

// Jest (CommonJS) cannot load the ESM-only @noble/hashes build that the bundle uses. Node's own
// SHA-256 stands in for these unit tests; the dialog tests below run the real bundle.
jest.mock('@noble/hashes/sha2.js', () => ({
  sha256: (data: Uint8Array) => new Uint8Array(jest.requireActual<typeof import('crypto')>('crypto').createHash('sha256').update(data).digest()),
}));
jest.mock('@noble/hashes/utils.js', () => ({
  bytesToHex: (bytes: Uint8Array) => Buffer.from(bytes).toString('hex'),
  utf8ToBytes: (text: string) => new Uint8Array(Buffer.from(text, 'utf8')),
}));
import { ORIGIN, PRIMARY, RECEIVER, baseTransfer, l1Value, renderedText } from './helpers';

const OWN = PRIMARY.address;
const hex = (n: number) => n.toString(16).padStart(40, '0');
const addr = (body: string) => `ZYN${body}`;
// Same first 4 and last 4 hex characters as RECEIVER, different middle (a poisoning lookalike).
const POISON = addr(`abab${'0'.repeat(32)}abab`);
const empty = () => sw.emptyKnown();

type Case = { receiver: string; amountAtoms: number; known: sw.KnownAddresses; account: { address: string } | null };

const CASES: Case[] = [
  { receiver: RECEIVER, amountAtoms: 5, known: empty(), account: { address: OWN } },
  { receiver: OWN, amountAtoms: 5, known: empty(), account: { address: OWN } },
  { receiver: sw.toChecksumAddress(OWN), amountAtoms: 5, known: empty(), account: { address: sw.toChecksumAddress(OWN) } },
  { receiver: RECEIVER, amountAtoms: 5, known: { contacts: [], sent: [RECEIVER], thresholdAtoms: null }, account: { address: OWN } },
  { receiver: POISON, amountAtoms: 5, known: { contacts: [], sent: [RECEIVER], thresholdAtoms: null }, account: { address: OWN } },
  { receiver: POISON, amountAtoms: 5, known: { contacts: [{ name: 'Test friend', address: RECEIVER }], sent: [], thresholdAtoms: null }, account: null },
  { receiver: RECEIVER, amountAtoms: 100, known: { contacts: [], sent: [RECEIVER], thresholdAtoms: 100 }, account: { address: OWN } },
  { receiver: RECEIVER, amountAtoms: 99, known: { contacts: [], sent: [RECEIVER], thresholdAtoms: 100 }, account: { address: OWN } },
  { receiver: addr(hex(1)), amountAtoms: 1, known: { contacts: [], sent: [addr(hex(2))], thresholdAtoms: null }, account: { address: OWN } },
  { receiver: addr(`1${'2'.repeat(38)}3`), amountAtoms: 1, known: { contacts: [], sent: [addr(`1${'f'.repeat(38)}3`)], thresholdAtoms: null }, account: { address: OWN } },
  {
    receiver: addr(hex(0)),
    amountAtoms: 1,
    known: { contacts: [], sent: Array.from({ length: 200 }, (_, i) => addr(hex(i + 1))), thresholdAtoms: 1 },
    account: { address: OWN },
  },
];

describe('send warnings: parity with l1 send-warnings (#1141, #1143)', () => {
  it.each(CASES.map((c, i) => [i, c] as const))('case %i matches l1 exactly', (_i, c) => {
    const expected = l1Value<{ warnings: unknown; lookalike: unknown; display: string; constants: unknown[] }>({
      op: 'sendWarnings',
      input: { receiver: c.receiver, amountAtoms: c.amountAtoms },
      account: c.account,
      known: c.known,
    });
    expect(sw.sendWarnings({ receiver: c.receiver, amountAtoms: c.amountAtoms }, c.account, c.known)).toStrictEqual(expected.warnings);
    expect(sw.lookalikeMatches(c.receiver, c.known)).toStrictEqual(expected.lookalike);
    expect(sw.displayAddress(c.receiver)).toBe(expected.display);
    expect([
      sw.SELF_SEND_MESSAGE, sw.KNOWN_MAX_CONTACTS, sw.KNOWN_MAX_SENT, sw.KNOWN_NAME_MAX,
      sw.LOOKALIKE_MIN_SHARED, sw.LOOKALIKE_MAX_DIFF, sw.LOOKALIKE_MAX_COMPARISONS, sw.LOOKALIKE_MAX_MATCHES,
    ]).toStrictEqual(expected.constants);
  });

  it('fails closed on a malformed own address, bad checksums and bad known data', () => {
    expect(() => sw.sendWarnings({ receiver: RECEIVER }, { address: 'ZYN12' }, empty())).toThrow();
    const bad = sw.toChecksumAddress(RECEIVER).replace(/[A-F]/u, (c) => c.toLowerCase());
    if (bad !== sw.toChecksumAddress(RECEIVER)) {
      expect(() => sw.sendWarnings({ receiver: bad }, null, empty())).toThrow(/checksum/u);
    }
    expect(() => sw.parseKnownAddresses({ contacts: [], sent: ['nope'], thresholdAtoms: null })).toThrow();
    expect(() => sw.parseKnownAddresses({ contacts: [], sent: [], thresholdAtoms: 0 })).toThrow();
    expect(() => sw.parseKnownAddresses({ contacts: [], sent: [], thresholdAtoms: null, extra: 1 })).toThrow();
  });

  it('recordSent keeps the newest 200, de-duplicated', () => {
    let known = empty();
    for (let i = 0; i < 205; i += 1) {
      known = sw.recordSent(known, addr(hex(i)));
    }
    known = sw.recordSent(known, addr(hex(100)));
    expect(known.sent).toHaveLength(200);
    expect(known.sent[0]).toBe(addr(hex(100)));
    expect(new Set(known.sent).size).toBe(200);
  });
});

/**
 * Signs and approves one transfer in an installed Snap.
 *
 * @param request - Snap request function.
 * @param overrides - Transfer overrides.
 * @returns Rendered dialog text.
 */
async function signAndApprove(request: Awaited<ReturnType<typeof installSnap>>['request'], overrides: Record<string, unknown>) {
  const pending = request({ method: 'zyron_signTransaction', origin: ORIGIN, params: { transaction: baseTransfer(overrides) } as any });
  const ui = (await pending.getInterface()) as SnapConfirmationInterface;
  const text = renderedText(ui.content);
  await ui.ok();
  const response = await pending;
  expect(((response as unknown as { response: { result?: unknown } }).response).result).toBeDefined();
  return text;
}

describe('send warnings in the Snap dialogs', () => {
  it('first-time warning, then none for a repeat receiver, then a lookalike with marked characters', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const first = await signAndApprove(request, {});
    expect(first).toMatch(/First-time recipient/u);
    expect(first).toContain(sw.displayAddress(RECEIVER));
    const again = await signAndApprove(request, { nonce: 2 });
    expect(again).not.toMatch(/First-time recipient|Lookalike/u);
    const look = await signAndApprove(request, { nonce: 3, receiver: POISON });
    expect(look).toMatch(/Lookalike address/u);
    expect(look).toMatch(/DIFFERENT address/u);
    expect(look).toMatch(/Address you sent to before/u);
    expect(look).toMatch(/\[[0-9a-fA-F]\]/u);
    expect(look).toMatch(/advisory/u);
  });

  it('refuses a self-send before any dialog', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const response = await request({ method: 'zyron_signTransaction', origin: ORIGIN, params: { transaction: baseTransfer({ receiver: OWN }) } as any });
    expect(response).toRespondWithError(expect.objectContaining({ code: -32602, message: sw.SELF_SEND_MESSAGE }));
  });

  it('large-amount threshold is set after confirmation and warns at or above it', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const bad = await request({ method: 'zyron_setWarningThreshold', origin: ORIGIN, params: { thresholdAtoms: 0 } as any });
    expect(bad).toRespondWithError(expect.objectContaining({ code: -32602 }));
    const pending = request({ method: 'zyron_setWarningThreshold', origin: ORIGIN, params: { thresholdAtoms: 150_000_000 } as any });
    const ui = (await pending.getInterface()) as SnapConfirmationInterface;
    expect(renderedText(ui.content)).toMatch(/1\.5 ZYN or more/u);
    await ui.ok();
    expect(await pending).toRespondWith({ thresholdAtoms: 150_000_000 });
    expect(await signAndApprove(request, {})).toMatch(/Large amount/u);
    expect(await signAndApprove(request, { nonce: 2, amountAtoms: 149_999_999 })).not.toMatch(/Large amount/u);
  });

  it('declining the threshold dialog changes nothing', async () => {
    const { request } = await installSnap({ options: { secretRecoveryPhrase: PRIMARY.mnemonic } });
    const pending = request({ method: 'zyron_setWarningThreshold', origin: ORIGIN, params: { thresholdAtoms: 1 } as any });
    const ui = (await pending.getInterface()) as SnapConfirmationInterface;
    await ui.cancel();
    expect(await pending).toRespondWithError(expect.objectContaining({ code: 4001 }));
    expect(await signAndApprove(request, {})).not.toMatch(/Large amount/u);
  });
});
