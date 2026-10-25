/**
 * Feature 6A: shared fail-closed intent renderer (docs/design/feature-6a-intent-renderer.md).
 *
 * Before a wallet key signs anything, the signer renders the exact payload into complete,
 * deterministic, ASCII-only lines, re-parses those lines back into a payload, rebuilds the
 * signing bytes and requires byte equality. Anything it cannot describe completely is refused
 * with IntentRenderRefusal, which callers must treat as "do not sign".
 *
 * Pure: no I/O, no clock, no randomness, no Intl, no floating point. Advisory only; it never
 * changes what consensus accepts (consensus still accepts transfer version 1).
 */
import { parseAddressInput, toChecksumAddress } from "./address-checksum.js";
import { canonicalJson } from "./codec.js";
import { addressFromPublicKey, isValidPublicKey } from "./crypto.js";
import { MINING_TRACKER_ADDRESS } from "./mining.js";
import { ATOMS_PER_ZYN, MAX_SUPPLY_ATOMS } from "./types.js";
import type { Address, TransferTx } from "./types.js";

export const RENDERER_VERSION = 1 as const;

/** Version 1 allowlist: transfer only, signed as transaction version 2 under this domain. */
export const TRANSFER_INTENT_DOMAIN = "zyronchain/transaction/transfer/v2";
export const RENDERABLE_KINDS: readonly string[] = Object.freeze(["transfer"]);

/** The exact signed key set of a version-2 transfer payload. */
export const TRANSFER_PAYLOAD_KEYS: readonly string[] = Object.freeze([
  "amountAtoms", "chainId", "feeAtoms", "kind", "nonce", "publicKey", "receiver", "sender", "timestampMs", "version"
]);

export const CHAIN_ID_RE = /^[a-z0-9-]{3,64}$/;
/**
 * R3 (Security L1): the FIXED list of chain IDs renderer version 1 may sign for. Any other ID is
 * refused, including every ID with a "mainnet" token. Identical to the PWA's RENDERABLE_CHAIN_IDS
 * (website/app/zyron-wallet-core.js). zyron-wallet-testnet-1 is listed for the PWA; the CLI still
 * refuses it because it advertises protocol 1 (transfer-version-policy.ts).
 */
export const RENDERABLE_CHAIN_IDS: readonly string[] = Object.freeze([
  "zyron-devnet-1",
  "zyron-wallet-testnet-1",
  "zyron-open-testnet-1"
]);

/** 9999-12-31T23:59:59.999Z: the largest timestamp with a 4-digit ISO-8601 year. */
export const MAX_RENDERABLE_TIMESTAMP_MS = 253_402_300_799_999;

export class IntentRenderRefusal extends Error {
  constructor(message: string) {
    super(`Refusing to sign: ${message}`);
    this.name = "IntentRenderRefusal";
  }
}

export interface RenderedLine {
  readonly label: string;
  readonly value: string;
}

export type TransferPayload = Omit<TransferTx, "signature" | "txid"> & { version: 2 };

export interface RenderedIntent {
  readonly rendererVersion: typeof RENDERER_VERSION;
  readonly kind: "transfer";
  readonly domain: string;
  readonly payload: Readonly<TransferPayload>;
  readonly lines: readonly RenderedLine[];
  readonly text: string;
  /** UTF-8 of canonicalJson({ domain, payload }), rebuilt from the rendered lines. */
  readonly signingBytesHex: string;
}

const genuine = new WeakSet<object>();
const encoder = new TextEncoder();

const LABELS = Object.freeze({
  kind: "Kind",
  version: "Version",
  chainId: "Chain ID",
  sender: "From",
  receiver: "To",
  amountAtoms: "Amount",
  feeAtoms: "Fee",
  total: "Total",
  nonce: "Nonce",
  timestampMs: "Timestamp",
  publicKey: "Public key",
  domain: "Domain"
});
const LINE_ORDER = [
  LABELS.kind, LABELS.version, LABELS.chainId, LABELS.sender, LABELS.receiver, LABELS.amountAtoms,
  LABELS.feeAtoms, LABELS.total, LABELS.nonce, LABELS.timestampMs, LABELS.publicKey, LABELS.domain
];

/** True only for the fixed RENDERABLE_CHAIN_IDS (any other chain needs a renderer version bump). */
export function isAllowedTestnetChainId(chainId: unknown): chainId is string {
  return typeof chainId === "string" && RENDERABLE_CHAIN_IDS.includes(chainId);
}

/** `<ZYN> ZYN (<atoms> atoms)` with BigInt division; trailing zeros trimmed; no separators. */
export function formatAtoms(atoms: bigint): string {
  if (atoms < 0n) throw new IntentRenderRefusal("negative amount");
  const per = BigInt(ATOMS_PER_ZYN);
  const whole = atoms / per;
  const fraction = (atoms % per).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole.toString()}${fraction ? `.${fraction}` : ""} ZYN (${atoms.toString()} atoms)`;
}

/** ISO-8601 UTC from integer milliseconds using integer-only civil-date math (no Date, no Intl). */
export function formatTimestampMs(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_RENDERABLE_TIMESTAMP_MS) {
    throw new IntentRenderRefusal("timestamp out of range");
  }
  const total = BigInt(ms);
  const days = total / 86_400_000n;
  let rest = total % 86_400_000n;
  const hh = rest / 3_600_000n; rest %= 3_600_000n;
  const mm = rest / 60_000n; rest %= 60_000n;
  const ss = rest / 1_000n;
  const milli = rest % 1_000n;
  // Howard Hinnant's days_from_civil inverse, in BigInt; days >= 0 here.
  const z = days + 719_468n;
  const era = z / 146_097n;
  const doe = z - era * 146_097n;
  const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
  const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
  const mp = (5n * doy + 2n) / 153n;
  const d = doy - (153n * mp + 2n) / 5n + 1n;
  const m = mp < 10n ? mp + 3n : mp - 9n;
  const y = yoe + era * 400n + (m <= 2n ? 1n : 0n);
  const p = (value: bigint, width: number) => value.toString().padStart(width, "0");
  return `${ms} ms (${p(y, 4)}-${p(m, 2)}-${p(d, 2)}T${p(hh, 2)}:${p(mm, 2)}:${p(ss, 2)}.${p(milli, 3)}Z)`;
}

function refuse(message: string): never {
  throw new IntentRenderRefusal(message);
}

const UNSAFE_TEXT_RE = /[^\x20-\x7e]/;

function assertSafeAscii(value: string, field: string): void {
  // Printable ASCII only: this excludes every control (U+0000-U+001F, U+007F), bidi and non-ASCII character.
  if (UNSAFE_TEXT_RE.test(value)) refuse(`${field} contains non-ASCII, control or bidi characters`);
}

function safeInteger(value: unknown, field: string, min: number, max: number): bigint {
  // Number.isSafeInteger is checked BEFORE any BigInt() conversion.
  if (typeof value !== "number" || !Number.isSafeInteger(value)) refuse(`${field} is not a safe integer`);
  if (value < min || value > max) refuse(`${field} is out of range`);
  return BigInt(value);
}

/** R2: the payload must already carry the exact canonical address; mixed case is refused, never normalized. */
function canonicalAddress(value: unknown, field: string): Address {
  if (typeof value !== "string") refuse(`${field} is not a string`);
  assertSafeAscii(value, field);
  let parsed;
  try {
    parsed = parseAddressInput(value);
  } catch {
    refuse(`${field} is not a valid address`);
  }
  if (parsed.canonical !== value) refuse(`${field} is not in canonical lower-case form (normalize at input, before building the payload)`);
  if (value === MINING_TRACKER_ADDRESS) refuse(`${field} is a protocol-reserved address`);
  return parsed.canonical;
}

function validateTransferPayload(payload: unknown): TransferPayload {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) refuse("payload is not a plain object");
  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype) refuse("payload is not a plain object");
  const record = payload as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== TRANSFER_PAYLOAD_KEYS.length || keys.some((key, index) => key !== TRANSFER_PAYLOAD_KEYS[index])) {
    refuse("payload has missing, unknown or extra fields");
  }
  if (typeof record.kind !== "string") refuse("kind is not a string");
  assertSafeAscii(record.kind, "kind");
  if (!RENDERABLE_KINDS.includes(record.kind)) refuse(`kind "${record.kind}" is not renderable by renderer version ${RENDERER_VERSION}`);
  if (record.version === 1) refuse("transaction version 1 (domainless signature) is not signed; use version 2");
  if (record.version !== 2) refuse("unsupported transaction version");
  if (typeof record.chainId !== "string") refuse("chainId is not a string");
  assertSafeAscii(record.chainId, "chainId");
  if (!isAllowedTestnetChainId(record.chainId)) refuse("chainId is not in the fixed list of renderable testnet or devnet chain IDs");
  const sender = canonicalAddress(record.sender, "sender");
  const receiver = canonicalAddress(record.receiver, "receiver");
  const amount = safeInteger(record.amountAtoms, "amountAtoms", 1, MAX_SUPPLY_ATOMS);
  const fee = safeInteger(record.feeAtoms, "feeAtoms", 0, MAX_SUPPLY_ATOMS);
  if (amount + fee > BigInt(MAX_SUPPLY_ATOMS)) refuse("amount + fee exceeds the maximum supply");
  safeInteger(record.nonce, "nonce", 1, Number.MAX_SAFE_INTEGER);
  safeInteger(record.timestampMs, "timestampMs", 0, MAX_RENDERABLE_TIMESTAMP_MS);
  if (typeof record.publicKey !== "string") refuse("publicKey is not a string");
  assertSafeAscii(record.publicKey, "publicKey");
  if (!isValidPublicKey(record.publicKey)) refuse("publicKey is not a valid secp256k1 public key");
  if (addressFromPublicKey(record.publicKey) !== sender) refuse("sender is not derived from publicKey");
  return {
    kind: "transfer",
    version: 2,
    chainId: record.chainId,
    nonce: record.nonce as number,
    sender,
    receiver,
    amountAtoms: record.amountAtoms as number,
    feeAtoms: record.feeAtoms as number,
    timestampMs: record.timestampMs as number,
    publicKey: record.publicKey
  };
}

function linesFor(domain: string, p: TransferPayload): RenderedLine[] {
  const amount = BigInt(p.amountAtoms);
  const fee = BigInt(p.feeAtoms);
  return [
    { label: LABELS.kind, value: "Transfer" },
    { label: LABELS.version, value: "2" },
    { label: LABELS.chainId, value: p.chainId },
    { label: LABELS.sender, value: toChecksumAddress(p.sender) },
    { label: LABELS.receiver, value: toChecksumAddress(p.receiver) },
    { label: LABELS.amountAtoms, value: formatAtoms(amount) },
    { label: LABELS.feeAtoms, value: formatAtoms(fee) },
    { label: LABELS.total, value: formatAtoms(amount + fee) },
    { label: LABELS.nonce, value: String(p.nonce) },
    { label: LABELS.timestampMs, value: formatTimestampMs(p.timestampMs) },
    { label: LABELS.publicKey, value: p.publicKey },
    { label: LABELS.domain, value: domain }
  ];
}

function atomsFromRendered(value: string, field: string): number {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,8}))? ZYN \((0|[1-9][0-9]*) atoms\)$/.exec(value);
  if (!match) refuse(`rendered ${field} cannot be parsed back`);
  const fromZyn = BigInt(match[1]!) * BigInt(ATOMS_PER_ZYN) + BigInt((match[2] ?? "").padEnd(8, "0") || "0");
  const atoms = BigInt(match[3]!);
  if (fromZyn !== atoms) refuse(`rendered ${field} ZYN and atoms disagree`);
  if (atoms > BigInt(Number.MAX_SAFE_INTEGER)) refuse(`rendered ${field} is not a safe integer`);
  return Number(atoms);
}

function integerFromRendered(value: string, field: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) refuse(`rendered ${field} cannot be parsed back`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) refuse(`rendered ${field} is not a safe integer`);
  return parsed;
}

/**
 * Re-parses rendered lines into { domain, payload }. Every signed value comes from the text the
 * user sees, never from the original object, so a display/bytes divergence cannot sign.
 */
export function parseRenderedLines(lines: readonly RenderedLine[]): { domain: string; payload: TransferPayload } {
  if (lines.length !== LINE_ORDER.length || lines.some((line, index) => line.label !== LINE_ORDER[index])) {
    refuse("rendered lines are incomplete or out of order");
  }
  const value = (index: number) => lines[index]!.value;
  if (value(0) !== "Transfer" || value(1) !== "2") refuse("rendered kind or version is not a version-2 transfer");
  const address = (text: string, field: string): Address => {
    try {
      return parseAddressInput(text).canonical;
    } catch {
      return refuse(`rendered ${field} cannot be parsed back`);
    }
  };
  const timestamp = /^(0|[1-9][0-9]*) ms \(/.exec(value(9));
  if (!timestamp) refuse("rendered timestamp cannot be parsed back");
  const payload: TransferPayload = {
    kind: "transfer",
    version: 2,
    chainId: value(2),
    nonce: integerFromRendered(value(8), "nonce"),
    sender: address(value(3), "sender"),
    receiver: address(value(4), "receiver"),
    amountAtoms: atomsFromRendered(value(5), "amount"),
    feeAtoms: atomsFromRendered(value(6), "fee"),
    timestampMs: integerFromRendered(timestamp[1]!, "timestamp"),
    publicKey: value(10)
  };
  const total = atomsFromRendered(value(7), "total");
  if (BigInt(total) !== BigInt(payload.amountAtoms) + BigInt(payload.feeAtoms)) refuse("rendered total is not amount + fee");
  return { domain: value(11), payload };
}

export function signingBytesFor(domain: string, payload: unknown): Uint8Array {
  return encoder.encode(canonicalJson({ domain, payload }));
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Renders a signing intent or throws IntentRenderRefusal. The result is frozen and marked genuine. */
export function renderIntent(input: { domain: unknown; payload: unknown }): RenderedIntent {
  if (input === null || typeof input !== "object") refuse("missing intent");
  const { domain } = input;
  if (typeof domain !== "string") refuse("domain is not a string");
  assertSafeAscii(domain, "domain");
  const payload = validateTransferPayload(input.payload);
  if (domain !== TRANSFER_INTENT_DOMAIN) refuse("domain does not match the transfer signing domain");
  const lines = linesFor(domain, payload).map((line) => Object.freeze({ ...line }));
  for (const line of lines) assertSafeAscii(`${line.label}: ${line.value}`, line.label);
  const text = lines.map((line) => `${line.label}: ${line.value}\n`).join("");
  const original = signingBytesFor(domain, payload);
  const reparsed = parseRenderedLines(lines);
  const rebuilt = signingBytesFor(reparsed.domain, reparsed.payload);
  if (hex(rebuilt) !== hex(original)) refuse("rendered text does not round-trip to the signing bytes");
  const rendered: RenderedIntent = Object.freeze({
    rendererVersion: RENDERER_VERSION,
    kind: "transfer",
    domain: reparsed.domain,
    payload: Object.freeze({ ...reparsed.payload }),
    lines: Object.freeze(lines),
    text,
    signingBytesHex: hex(rebuilt)
  });
  genuine.add(rendered);
  return rendered;
}

/** Requires the bytes a caller is about to sign to equal the bytes rebuilt from the rendered text. */
export function assertRenderMatchesSigningBytes(rendered: RenderedIntent, signingBytes: Uint8Array): void {
  assertGenuineRenderedIntent(rendered);
  const rebuilt = parseRenderedLines(rendered.lines);
  if (hex(signingBytesFor(rebuilt.domain, rebuilt.payload)) !== hex(signingBytes)) {
    refuse("signing bytes do not match the rendered intent");
  }
}

/** Refuses any RenderedIntent that renderIntent did not produce (no hand-built or edited objects). */
export function assertGenuineRenderedIntent(rendered: unknown): asserts rendered is RenderedIntent {
  if (rendered === null || typeof rendered !== "object" || !genuine.has(rendered)) {
    refuse("not a RenderedIntent produced by renderIntent");
  }
}
