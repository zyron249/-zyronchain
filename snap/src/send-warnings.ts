import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from './constants';

/**
 * Advisory send-safety warnings for the Snap.
 *
 * A port of l1/src/send-warnings.ts (#1141, #1143), which itself mirrors
 * website/app/zyron-wallet-core.js. test/send-warnings.test.ts runs the real
 * l1 code through the test oracle and checks that both give the same result.
 * Pure local logic: no network, no chain state. The known-address list
 * (sent history and threshold) lives only in the Snap's encrypted state and is
 * never sent anywhere.
 */
export const SELF_SEND_MESSAGE = "You can't send to your own address. Enter a different recipient.";
export const KNOWN_MAX_CONTACTS = 100;
export const KNOWN_MAX_SENT = 200;
export const KNOWN_NAME_MAX = 64;
export const LOOKALIKE_MIN_SHARED = 6;
export const LOOKALIKE_MAX_DIFF = 2;
export const LOOKALIKE_MAX_COMPARISONS = 250;
export const LOOKALIKE_MAX_MATCHES = 3;
export const ADDRESS_CHECKSUM_DOMAIN = 'zyronchain/address-checksum/v1:';

const CANONICAL_RE = /^ZYN[0-9a-f]{40}$/u;
const INPUT_RE = /^ZYN[0-9a-fA-F]{40}$/u;

export type KnownContact = { name: string; address: string };
export type KnownAddresses = { contacts: KnownContact[]; sent: string[]; thresholdAtoms: number | null };
export type LookalikeMatch = {
  address: string;
  name: string | null;
  source: 'contact' | 'history';
  diff: number[];
  prefix: number;
  suffix: number;
};
export type LookalikeResult = { receiver: string; matches: LookalikeMatch[]; compared: number; truncated: boolean };
export type SendWarning =
  | { code: 'self'; blocking: true; message: string }
  | { code: 'lookalike'; blocking: false; receiver: string; matches: LookalikeMatch[]; message: string }
  | { code: 'first-time'; blocking: false; message: string }
  | { code: 'large-amount'; blocking: false; message: string };

/**
 * Display-only mixed-case checksum (same rule as l1 address-checksum).
 *
 * @param address - Canonical address.
 * @returns Checksummed address.
 */
export function toChecksumAddress(address: string): string {
  if (!CANONICAL_RE.test(address)) {
    throw new Error('Address must be canonical: ZYN + 40 lower-case hex');
  }
  const hash = bytesToHex(sha256(utf8ToBytes(`${ADDRESS_CHECKSUM_DOMAIN}${address}`)));
  let out = 'ZYN';
  for (let index = 0; index < 40; index += 1) {
    const char = address[3 + index] as string;
    out += char >= 'a' && char <= 'f' && parseInt(hash[index] as string, 16) >= 8 ? char.toUpperCase() : char;
  }
  return out;
}

/**
 * Accepts canonical or correctly checksummed input; returns the canonical form.
 *
 * @param input - Address text.
 * @returns Canonical address.
 */
export function canonicalAddress(input: unknown): string {
  if (typeof input !== 'string' || !INPUT_RE.test(input)) {
    throw new Error('Invalid address: expected ZYN followed by 40 hex characters');
  }
  const canonical = `ZYN${input.slice(3).toLowerCase()}`;
  if (input !== canonical && input !== toChecksumAddress(canonical)) {
    throw new Error('Address checksum mismatch: the mixed-case letters do not match (likely a typo)');
  }
  return canonical;
}

/**
 * "ZYN" followed by the 40 hex characters in 4-character blocks.
 *
 * @param address - Address.
 * @returns Grouped text.
 */
export function groupAddress(address: string): string {
  return `ZYN ${(address.slice(3).match(/.{1,4}/gu) ?? []).join(' ')}`;
}

/**
 * Full checksummed address in 4-character blocks.
 *
 * @param address - Address.
 * @returns Grouped checksummed text.
 */
export function displayAddress(address: string): string {
  return groupAddress(toChecksumAddress(canonicalAddress(address)));
}

/**
 * Empty known-address data.
 *
 * @returns A fresh empty book.
 */
export function emptyKnown(): KnownAddresses {
  return { contacts: [], sent: [], thresholdAtoms: null };
}

/**
 * @param value - Value.
 * @returns Whether it is a plain object.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/**
 * Validates untrusted known-address data and returns a fresh copy. Fails closed.
 *
 * @param value - Untrusted data.
 * @returns Validated copy.
 */
export function parseKnownAddresses(value: unknown): KnownAddresses {
  if (!isPlainObject(value) || Object.keys(value).sort().join(',') !== 'contacts,sent,thresholdAtoms') {
    throw new Error('Known-address data is invalid (expected contacts, sent, thresholdAtoms)');
  }
  if (!Array.isArray(value.contacts) || value.contacts.length > KNOWN_MAX_CONTACTS) {
    throw new Error('Known-address contacts are invalid');
  }
  if (!Array.isArray(value.sent) || value.sent.length > KNOWN_MAX_SENT) {
    throw new Error('Known-address history is invalid');
  }
  const seen = new Set<string>();
  const contacts = value.contacts.map((entry: unknown): KnownContact => {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(',') !== 'address,name') {
      throw new Error('Known-address contact is invalid');
    }
    if (typeof entry.address !== 'string' || !CANONICAL_RE.test(entry.address) || seen.has(entry.address)) {
      throw new Error('Known-address contact address is invalid');
    }
    seen.add(entry.address);
    const name = typeof entry.name === 'string' ? entry.name.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
    // eslint-disable-next-line no-control-regex
    if (!name || name.length > KNOWN_NAME_MAX || /[\u0000-\u001f\u007f]/u.test(name) || name !== entry.name) {
      throw new Error('Known-address contact name is invalid');
    }
    return { name, address: entry.address };
  });
  const sentSeen = new Set<string>();
  const sent = value.sent.map((entry: unknown): string => {
    if (typeof entry !== 'string' || !CANONICAL_RE.test(entry) || sentSeen.has(entry)) {
      throw new Error('Known-address history is invalid');
    }
    sentSeen.add(entry);
    return entry;
  });
  const threshold = value.thresholdAtoms;
  if (threshold !== null && !(typeof threshold === 'number' && Number.isSafeInteger(threshold) && threshold >= 1 && threshold <= MAX_SUPPLY_ATOMS)) {
    throw new Error('Send-warning threshold is invalid');
  }
  return { contacts, sent, thresholdAtoms: threshold as number | null };
}

/**
 * Most recent first, de-duplicated, capped at KNOWN_MAX_SENT (same as the PWA).
 *
 * @param known - Known addresses.
 * @param receiver - Receiver that was just signed for.
 * @returns Updated copy.
 */
export function recordSent(known: KnownAddresses, receiver: string): KnownAddresses {
  const book = parseKnownAddresses(known);
  const address = canonicalAddress(receiver);
  book.sent = [address, ...book.sent.filter((entry) => entry !== address)].slice(0, KNOWN_MAX_SENT);
  return book;
}

/**
 * Sets or clears (null) the large-amount threshold.
 *
 * @param known - Known addresses.
 * @param atoms - Threshold in atoms or null.
 * @returns Updated copy.
 */
export function setThreshold(known: KnownAddresses, atoms: unknown): KnownAddresses {
  const book = parseKnownAddresses(known);
  if (atoms !== null && !(typeof atoms === 'number' && Number.isSafeInteger(atoms) && atoms >= 1 && atoms <= MAX_SUPPLY_ATOMS)) {
    throw new Error(`Threshold must be null or an integer number of atoms between 1 and ${MAX_SUPPLY_ATOMS}`);
  }
  book.thresholdAtoms = atoms;
  return book;
}

/**
 * Known addresses that look like the receiver but are a different full address.
 *
 * @param receiverInput - Receiver.
 * @param known - Known addresses.
 * @returns Matches.
 */
export function lookalikeMatches(receiverInput: string, known: KnownAddresses): LookalikeResult {
  const book = parseKnownAddresses(known);
  const receiver = canonicalAddress(receiverInput);
  const rx = receiver.slice(3);
  const candidates: { address: string; name: string | null; source: 'contact' | 'history' }[] = [];
  const seen = new Set<string>();
  for (const contact of book.contacts) {
    if (!seen.has(contact.address)) {
      seen.add(contact.address);
      candidates.push({ address: contact.address, name: contact.name, source: 'contact' });
    }
  }
  for (const address of book.sent) {
    if (!seen.has(address)) {
      seen.add(address);
      candidates.push({ address, name: null, source: 'history' });
    }
  }
  const checked = candidates.slice(0, LOOKALIKE_MAX_COMPARISONS);
  const matches: LookalikeMatch[] = [];
  for (const candidate of checked) {
    if (candidate.address === receiver) {
      continue;
    }
    const kx = candidate.address.slice(3);
    let prefix = 0;
    while (prefix < 40 && kx[prefix] === rx[prefix]) {
      prefix += 1;
    }
    let suffix = 0;
    while (suffix < 40 - prefix && kx[39 - suffix] === rx[39 - suffix]) {
      suffix += 1;
    }
    const diff: number[] = [];
    for (let index = 0; index < 40; index += 1) {
      if (kx[index] !== rx[index]) {
        diff.push(index);
      }
    }
    if (diff.length === 0) {
      continue;
    }
    if (prefix + suffix >= LOOKALIKE_MIN_SHARED || diff.length <= LOOKALIKE_MAX_DIFF) {
      matches.push({ ...candidate, diff, prefix, suffix });
      if (matches.length >= LOOKALIKE_MAX_MATCHES) {
        break;
      }
    }
  }
  return { receiver, matches, compared: checked.length, truncated: candidates.length > checked.length };
}

/**
 * @param atoms - Atoms.
 * @returns Plain decimal ZYN (same format as l1).
 */
function atomsToZyn(atoms: number): string {
  const whole = Math.floor(atoms / ATOMS_PER_ZYN);
  const fraction = String(atoms % ATOMS_PER_ZYN).padStart(8, '0').replace(/0+$/u, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * Local send-safety checks. Only `self` is blocking; the rest are advisory.
 *
 * @param input - Receiver and amount.
 * @param input.receiver - Receiver.
 * @param input.amountAtoms - Amount.
 * @param account - Own account (address is normalized; malformed throws).
 * @param account.address - Own address.
 * @param known - Known addresses.
 * @returns Warnings.
 */
export function sendWarnings(
  input: { receiver: string; amountAtoms?: number },
  account: { address: string } | null,
  known: KnownAddresses,
): SendWarning[] {
  const book = parseKnownAddresses(known);
  const out: SendWarning[] = [];
  const receiver = canonicalAddress(input.receiver);
  if (account && receiver === canonicalAddress(account.address)) {
    out.push({ code: 'self', blocking: true, message: SELF_SEND_MESSAGE });
    return out;
  }
  const look = lookalikeMatches(receiver, book);
  const first = look.matches[0];
  if (first) {
    const who = first.source === 'contact' ? `your saved contact "${first.name}"` : 'an address you sent to before';
    out.push({
      code: 'lookalike',
      blocking: false,
      receiver,
      matches: look.matches,
      message: `This address looks like ${who} but it is a DIFFERENT address. Scammers create lookalike addresses with the same start and end. Compare every character.`,
    });
  }
  const contact = book.contacts.find((entry) => entry.address === receiver);
  if (!book.sent.includes(receiver)) {
    out.push({
      code: 'first-time',
      blocking: false,
      message: contact
        ? `You have not sent to this address from this wallet before (saved contact "${contact.name}"). Check every character of the address.`
        : 'You have never sent to this address from this wallet, and it is not in your address book. Check every character of the address.',
    });
  }
  const amount = input.amountAtoms;
  if (book.thresholdAtoms !== null && typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= book.thresholdAtoms) {
    out.push({
      code: 'large-amount',
      blocking: false,
      message: `The amount (${atomsToZyn(amount)} ZYN) is at or above your warning threshold of ${atomsToZyn(book.thresholdAtoms)} ZYN.`,
    });
  }
  return out;
}
