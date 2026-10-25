import { parseAddressInput, toChecksumAddress } from "./address-checksum.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS, type Address } from "./types.js";

/**
 * Advisory send-safety warnings (feature 7), shared by the CLI and any wallet that can load l1.
 *
 * This is a byte-for-byte port of `sendWarnings` / `lookalikeMatches` in
 * website/app/zyron-wallet-core.js (#1110, #1127); a parity test keeps them aligned.
 * Pure local logic: no network, no chain state. It never changes consensus, block validity,
 * mempool admission, genesis, supply or keys. The known-address list (contacts and sent
 * history) is private, stays local, and is never sent to a node.
 */
export const SELF_SEND_MESSAGE = "You can't send to your own address. Enter a different recipient.";
export const KNOWN_MAX_CONTACTS = 100;
export const KNOWN_MAX_SENT = 200;
export const KNOWN_NAME_MAX = 64;
/**
 * Lookalike (address-poisoning) rule: a known address that is NOT the same full address but whose
 * common hex prefix length + common hex suffix length (non-overlapping) is at least
 * LOOKALIKE_MIN_SHARED, for any split, or that differs in at most LOOKALIKE_MAX_DIFF hex positions.
 * At most LOOKALIKE_MAX_COMPARISONS known addresses (contacts first, then history) are compared.
 */
export const LOOKALIKE_MIN_SHARED = 6;
export const LOOKALIKE_MAX_DIFF = 2;
export const LOOKALIKE_MAX_COMPARISONS = 250;
export const LOOKALIKE_MAX_MATCHES = 3;

const CANONICAL_RE = /^ZYN[0-9a-f]{40}$/;

export interface KnownContact { name: string; address: Address }
export interface KnownAddresses { contacts: KnownContact[]; sent: Address[]; thresholdAtoms: number | null }
export interface LookalikeMatch {
  address: Address;
  name: string | null;
  source: "contact" | "history";
  diff: number[];
  prefix: number;
  suffix: number;
}
export interface LookalikeResult { receiver: Address; matches: LookalikeMatch[]; compared: number; truncated: boolean }
export type SendWarning =
  | { code: "self"; blocking: true; message: string }
  | { code: "lookalike"; blocking: false; receiver: Address; matches: LookalikeMatch[]; message: string }
  | { code: "first-time"; blocking: false; message: string }
  | { code: "large-amount"; blocking: false; message: string };

/** "ZYN" followed by the 40 hex characters in 4-character blocks. */
export function groupAddress(address: string): string {
  return `ZYN ${(address.slice(3).match(/.{1,4}/g) ?? []).join(" ")}`;
}

/** Full checksummed address in 4-character blocks, for every place an address is shown. */
export function displayAddress(address: string): string {
  return groupAddress(toChecksumAddress(parseAddressInput(address).canonical));
}

/** Indices (0..39) of the hex characters that differ between two addresses (case-insensitive). */
export function addressDiff(a: string, b: string): number[] {
  const x = parseAddressInput(a).canonical.slice(3);
  const y = parseAddressInput(b).canonical.slice(3);
  const out: number[] = [];
  for (let index = 0; index < 40; index += 1) if (x[index] !== y[index]) out.push(index);
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeName(name: unknown): string {
  const text = String(name ?? "").normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text) throw new Error("Contact name is required");
  if (text.length > KNOWN_NAME_MAX) throw new Error(`Contact name is too long (at most ${KNOWN_NAME_MAX} characters)`);
  if (/[\u0000-\u001f\u007f]/.test(text)) throw new Error("Contact name has control characters");
  return text;
}

/**
 * Validates untrusted known-address data (same shape and bounds as the PWA's decrypted book:
 * `{contacts:[{name,address}], sent:[address], thresholdAtoms}`) and returns a fresh copy. Fails closed.
 */
export function parseKnownAddresses(value: unknown): KnownAddresses {
  if (!isPlainObject(value) || Object.keys(value).sort().join(",") !== "contacts,sent,thresholdAtoms") {
    throw new Error("Known-address data is invalid (expected contacts, sent, thresholdAtoms)");
  }
  if (!Array.isArray(value.contacts) || value.contacts.length > KNOWN_MAX_CONTACTS) throw new Error("Known-address contacts are invalid");
  if (!Array.isArray(value.sent) || value.sent.length > KNOWN_MAX_SENT) throw new Error("Known-address history is invalid");
  const seen = new Set<string>();
  const contacts = value.contacts.map((entry: unknown): KnownContact => {
    if (!isPlainObject(entry) || Object.keys(entry).sort().join(",") !== "address,name") throw new Error("Known-address contact is invalid");
    if (typeof entry.address !== "string" || !CANONICAL_RE.test(entry.address) || seen.has(entry.address)) {
      throw new Error("Known-address contact address is invalid");
    }
    seen.add(entry.address);
    const name = normalizeName(entry.name);
    if (name !== entry.name) throw new Error("Known-address contact name is invalid");
    return { name, address: entry.address as Address };
  });
  const sentSeen = new Set<string>();
  const sent = value.sent.map((entry: unknown): Address => {
    if (typeof entry !== "string" || !CANONICAL_RE.test(entry) || sentSeen.has(entry)) throw new Error("Known-address history is invalid");
    sentSeen.add(entry);
    return entry as Address;
  });
  const threshold = value.thresholdAtoms;
  if (threshold !== null && !(typeof threshold === "number" && Number.isSafeInteger(threshold) && threshold >= 1 && threshold <= MAX_SUPPLY_ATOMS)) {
    throw new Error("Send-warning threshold is invalid");
  }
  return { contacts, sent, thresholdAtoms: threshold as number | null };
}

/** Known addresses that look like the receiver but are a different full address. */
export function lookalikeMatches(receiverInput: string, known: KnownAddresses): LookalikeResult {
  const book = parseKnownAddresses(known);
  const receiver = parseAddressInput(receiverInput).canonical;
  const rx = receiver.slice(3);
  const candidates: Array<{ address: Address; name: string | null; source: "contact" | "history" }> = [];
  const seen = new Set<string>();
  for (const c of book.contacts) if (!seen.has(c.address)) { seen.add(c.address); candidates.push({ address: c.address, name: c.name, source: "contact" }); }
  for (const a of book.sent) if (!seen.has(a)) { seen.add(a); candidates.push({ address: a, name: null, source: "history" }); }
  const checked = candidates.slice(0, LOOKALIKE_MAX_COMPARISONS);
  const matches: LookalikeMatch[] = [];
  for (const k of checked) {
    if (k.address === receiver) continue; // exact full match is never a lookalike
    const kx = k.address.slice(3);
    let prefix = 0;
    while (prefix < 40 && kx[prefix] === rx[prefix]) prefix += 1;
    let suffix = 0; // bounded by 40 - prefix so no character counts twice
    while (suffix < 40 - prefix && kx[39 - suffix] === rx[39 - suffix]) suffix += 1;
    const ends = prefix + suffix >= LOOKALIKE_MIN_SHARED;
    const diff: number[] = [];
    for (let index = 0; index < 40; index += 1) if (kx[index] !== rx[index]) diff.push(index);
    if (diff.length === 0) continue;
    if (ends || diff.length <= LOOKALIKE_MAX_DIFF) {
      matches.push({ address: k.address, name: k.name, source: k.source, diff, prefix, suffix });
      if (matches.length >= LOOKALIKE_MAX_MATCHES) break;
    }
  }
  return { receiver, matches, compared: checked.length, truncated: candidates.length > checked.length };
}

function atomsToZyn(atoms: number): string {
  if (!Number.isSafeInteger(atoms) || atoms < 0 || atoms > MAX_SUPPLY_ATOMS) throw new Error("Amount exceeds the 50,000,000 ZYN fixed-supply design");
  const whole = Math.floor(atoms / ATOMS_PER_ZYN);
  const fraction = String(atoms % ATOMS_PER_ZYN).padStart(8, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * Local send-safety checks. Only `self` is blocking (l1 already rejects self-transfers); every
 * other warning is acknowledge-only and advisory.
 */
export function sendWarnings(
  input: { receiver: string; amountAtoms?: number },
  account: { address: string } | null,
  known: KnownAddresses
): SendWarning[] {
  const book = parseKnownAddresses(known);
  const out: SendWarning[] = [];
  const receiver = parseAddressInput(input.receiver).canonical;
  if (account && receiver === account.address) {
    out.push({ code: "self", blocking: true, message: SELF_SEND_MESSAGE });
    return out;
  }
  const look = lookalikeMatches(receiver, book);
  if (look.matches.length) {
    const m = look.matches[0]!;
    out.push({
      code: "lookalike", blocking: false, receiver, matches: look.matches,
      message: `This address looks like ${m.source === "contact" ? `your saved contact "${m.name}"` : "an address you sent to before"}`
        + " but it is a DIFFERENT address. Scammers create lookalike addresses with the same start and end. Compare every character."
    });
  }
  const contact = book.contacts.find((c) => c.address === receiver);
  if (!book.sent.includes(receiver)) {
    out.push({
      code: "first-time", blocking: false, message: contact
        ? `You have not sent to this address from this wallet before (saved contact "${contact.name}"). Check every character of the address.`
        : "You have never sent to this address from this wallet, and it is not in your address book. Check every character of the address."
    });
  }
  const amount = input.amountAtoms;
  if (book.thresholdAtoms !== null && typeof amount === "number" && Number.isSafeInteger(amount) && amount >= book.thresholdAtoms) {
    out.push({
      code: "large-amount", blocking: false,
      message: `The amount (${atomsToZyn(amount)} ZYN) is at or above your warning threshold of ${atomsToZyn(book.thresholdAtoms)} ZYN.`
    });
  }
  return out;
}
