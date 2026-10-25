#!/usr/bin/env node
// Regenerates l1/test/vectors/intent-render-v1.json from the l1 renderer (feature 6A).
// Usage (from l1/): npm run build && node scripts/generate-intent-render-vectors.mjs
// The output is deterministic: fixed keys, fixed timestamps, no clock or randomness.
import { writeFile } from "node:fs/promises";
import { canonicalJson } from "../dist/src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { toChecksumAddress } from "../dist/src/address-checksum.js";
import { RENDERER_VERSION, TRANSFER_INTENT_DOMAIN, parseRenderedLines, renderIntent, signingBytesFor } from "../dist/src/intent-render.js";

const out = new URL("../test/vectors/intent-render-v1.json", import.meta.url);
const senderKey = "6a".padStart(64, "0");
const otherKey = "6b".padStart(64, "0");
const publicKey = publicKeyFromPrivate(senderKey);
const sender = addressFromPublicKey(publicKey);
const receiver = addressFromPublicKey(publicKeyFromPrivate(otherKey));
const MAX_SUPPLY_ATOMS = 50_000_000 * 100_000_000;
const base = {
  kind: "transfer", version: 2, chainId: "zyron-open-testnet-1", nonce: 7, sender, receiver,
  amountAtoms: 150_000_000, feeAtoms: 100_000, timestampMs: 1_761_408_000_000, publicKey
};
const mixed = (address) => {
  const checksummed = toChecksumAddress(address);
  if (checksummed === address) throw new Error("vector address has no upper-case letters");
  return checksummed;
};
const hex = (value) => Buffer.from(canonicalJson(value), "utf8").toString("hex");

const valid = [
  ["typical transfer 1.5 ZYN", {}],
  ["one atom, zero fee", { amountAtoms: 1, feeAtoms: 0 }],
  ["whole ZYN", { amountAtoms: 100_000_000 }],
  ["fee floor 100000 atoms", { feeAtoms: 100_000 }],
  ["max supply amount, zero fee", { amountAtoms: MAX_SUPPLY_ATOMS, feeAtoms: 0 }],
  ["max safe nonce", { nonce: Number.MAX_SAFE_INTEGER }],
  ["epoch timestamp", { timestampMs: 0 }],
  ["devnet chain ID", { chainId: "zyron-devnet-1" }],
  ["wallet testnet chain ID (renderable; the CLI refuses it by protocol)", { chainId: "zyron-wallet-testnet-1" }],
  // Mixed-case (checksummed) addresses are accepted only at user input; the payload carries the canonical form.
  ["checksummed user input normalized before the payload", { userInputReceiver: mixed(receiver) }]
];
const refusals = [
  ["unknown kind", { kind: "mining_claim" }],
  ["version 1 refused", { version: 1 }],
  ["unknown version", { version: 3 }],
  ["domain mismatch", {}, "zyronchain/transaction/transfer/v1"],
  ["extra field", { memo: "hi" }],
  ["missing field", { feeAtoms: undefined }],
  ["wrong type amount (string)", { amountAtoms: "150000000" }],
  ["unsafe amount", { amountAtoms: Number.MAX_SAFE_INTEGER + 1 }],
  ["negative fee", { feeAtoms: -1 }],
  ["zero amount", { amountAtoms: 0 }],
  ["fractional amount", { amountAtoms: 1.5 }],
  ["amount + fee over supply", { amountAtoms: MAX_SUPPLY_ATOMS, feeAtoms: 1 }],
  ["zero nonce", { nonce: 0 }],
  ["negative timestamp", { timestampMs: -1 }],
  ["timestamp past year 9999", { timestampMs: 253_402_300_800_000 }],
  ["non-testnet chain ID (R3)", { chainId: "zyron-mainnet-1" }],
  ["chain ID only matching the shape regex (R3)", { chainId: "zyron-cli-v5" }],
  ["mainnet token before testnet (R3 fixed list)", { chainId: "zyron-mainnet-testnet" }],
  ["mainnet-devnet (R3 fixed list)", { chainId: "mainnet-devnet" }],
  ["devnet-mainnet-1 (R3 fixed list)", { chainId: "devnet-mainnet-1" }],
  ["bare testnet (R3 fixed list)", { chainId: "testnet" }],
  ["mainnet token inside a testnet ID (R3 fixed list)", { chainId: "zyron-mainnet-1-testnet" }],
  ["unlisted testnet ID (R3 fixed list)", { chainId: "zyron-testnet-1" }],
  ["unlisted devnet ID (R3 fixed list)", { chainId: "zyron-devnet-2" }],
  ["non-ASCII chain ID", { chainId: "zyron-testnet-\u00e9" }],
  ["control character in chain ID", { chainId: "zyron-testnet-1\u0000" }],
  ["bidi override in chain ID", { chainId: "zyron-\u202etestnet-1" }],
  ["mixed-case payload receiver (R2)", { receiver: mixed(receiver) }],
  ["mixed-case payload sender (R2)", { sender: mixed(sender) }],
  ["upper-case hex receiver (R2)", { receiver: `ZYN${receiver.slice(3).toUpperCase()}` }],
  ["bad address", { receiver: "ZYNnot-an-address" }],
  ["reserved receiver", { receiver: `ZYN${"0".repeat(40)}` }],
  ["sender not derived from publicKey", { sender: receiver }],
  ["invalid public key", { publicKey: "00".repeat(64) }],
  ["non-string publicKey (number)", { publicKey: 1 }],
  ["non-string publicKey (null)", { publicKey: null }],
  ["non-string domain (number)", {}, 42],
  ["non-string domain (null)", {}, null],
  ["non-ASCII domain", {}, "zyronchain/transaction/transfer/v2\u00e9"],
  ["control character in domain", {}, "zyronchain/transaction/transfer/v2\u0000"],
  ["unsafe nonce", { nonce: Number.MAX_SAFE_INTEGER + 1 }],
  ["wrong type nonce (string)", { nonce: "7" }],
  ["wrong type nonce (boolean)", { nonce: true }],
  ["unsafe fee", { feeAtoms: Number.MAX_SAFE_INTEGER + 1 }],
  ["wrong type fee (string)", { feeAtoms: "100000" }],
  ["wrong type fee (null)", { feeAtoms: null }],
  ["unsafe timestamp", { timestampMs: Number.MAX_SAFE_INTEGER + 1 }],
  ["wrong type timestamp (string)", { timestampMs: "1761408000000" }],
  ["fractional timestamp", { timestampMs: 1_761_408_000_000.5 }],
  // `construct` tells consumers to rebuild the payload with this prototype before rendering.
  ["non-plain prototype (null prototype)", { construct: "null-prototype" }],
  ["non-plain prototype (class instance)", { construct: "class-instance" }],
  ["non-plain prototype (array)", { construct: "array" }]
];

/** Rebuilds a vector payload with a non-plain prototype (shared by the generator and the consumers). */
function constructPayload(payload) {
  const { construct, ...fields } = payload;
  if (construct === undefined) return payload;
  if (construct === "null-prototype") return Object.assign(Object.create(null), fields);
  if (construct === "class-instance") return Object.assign(new (class TransferLike {})(), fields);
  if (construct === "array") return Object.assign([], fields);
  throw new Error(`unknown construct ${construct}`);
}

// Rendered-line tampering: edits applied to the lines of the valid case "typical transfer 1.5 ZYN".
// Each must be refused when the lines are parsed back, or rebuild bytes that differ from the signed bytes.
const tamperings = [
  ["dropped line", { op: "drop", index: 11 }],
  ["extra line", { op: "append", label: "Memo", value: "hi" }],
  ["swapped lines", { op: "swap", index: 3, with: 4 }],
  ["relabelled line", { op: "set", index: 4, label: "Receiver" }],
  ["kind changed", { op: "set", index: 0, value: "Mining claim" }],
  ["version changed to 1", { op: "set", index: 1, value: "1" }],
  ["total disagrees with amount + fee", { op: "set", index: 7, value: "1.5 ZYN (150000000 atoms)" }],
  ["amount display disagrees with its atoms", { op: "set", index: 5, value: "15 ZYN (150000000 atoms)" }],
  ["nonce not an integer", { op: "set", index: 8, value: "7.0" }],
  ["unsafe nonce", { op: "set", index: 8, value: "9007199254740993" }],
  ["timestamp text unparseable", { op: "set", index: 9, value: "soon" }],
  ["receiver not an address", { op: "set", index: 4, value: "ZYNnot-an-address" }],
  ["receiver swapped for another valid address", { op: "set", index: 4, value: sender }],
  ["amount and total raised consistently", { op: "amount", amountAtoms: 250_000_000 }],
  ["chain ID edited", { op: "set", index: 2, value: "zyron-devnet-1" }],
  ["domain edited", { op: "set", index: 11, value: "zyronchain/transaction/transfer/v1" }]
];
function tamper(lines, edit) {
  const copy = lines.map((line) => ({ ...line }));
  if (edit.op === "drop") copy.splice(edit.index, 1);
  else if (edit.op === "append") copy.push({ label: edit.label, value: edit.value });
  else if (edit.op === "swap") [copy[edit.index], copy[edit.with]] = [copy[edit.with], copy[edit.index]];
  else if (edit.op === "set") copy[edit.index] = { label: edit.label ?? copy[edit.index].label, value: edit.value ?? copy[edit.index].value };
  else if (edit.op === "amount") {
    const zyn = (atoms) => `${atoms / 100_000_000} ZYN (${atoms} atoms)`;
    copy[5] = { label: "Amount", value: zyn(edit.amountAtoms) };
    copy[7] = { label: "Total", value: zyn(edit.amountAtoms + base.feeAtoms) };
  } else throw new Error(`unknown tamper op ${edit.op}`);
  return copy;
}

const cases = [];
for (const [name, patch] of valid) {
  const { userInputReceiver, ...rest } = patch;
  const payload = { ...base, ...rest };
  const rendered = renderIntent({ domain: TRANSFER_INTENT_DOMAIN, payload });
  cases.push({
    name, domain: TRANSFER_INTENT_DOMAIN, ...(userInputReceiver ? { userInputReceiver } : {}), payload,
    signingBytesHex: hex({ domain: TRANSFER_INTENT_DOMAIN, payload }),
    expected: { lines: rendered.lines, text: rendered.text }
  });
}
for (const [name, patch, domainOverride] of refusals) {
  const payload = { ...base, ...patch };
  for (const key of Object.keys(payload)) if (payload[key] === undefined) delete payload[key];
  const domain = domainOverride === undefined ? TRANSFER_INTENT_DOMAIN : domainOverride;
  let refusal;
  try {
    renderIntent({ domain, payload: constructPayload(payload) });
  } catch (error) {
    if (error.name !== "IntentRenderRefusal") throw error;
    refusal = error.message;
  }
  if (!refusal) throw new Error(`refusal vector "${name}" rendered`);
  let signingBytesHex = null; // null: the payload is not even canonical-JSON encodable
  if (payload.construct === undefined) {
    try { signingBytesHex = hex({ domain, payload }); } catch { /* keep null */ }
  }
  cases.push({ name, domain, payload, signingBytesHex, expected: { refusal } });
}
const reference = cases.find((entry) => entry.name === "typical transfer 1.5 ZYN");
const lineTampering = [];
for (const [name, edit] of tamperings) {
  const lines = tamper(reference.expected.lines, edit);
  let refusal;
  try {
    const parsed = parseRenderedLines(lines);
    const rebuilt = Buffer.from(signingBytesFor(parsed.domain, parsed.payload)).toString("hex");
    if (rebuilt === reference.signingBytesHex) throw new Error(`tampering vector "${name}" rebuilt the signed bytes`);
    refusal = "Refusing to sign: signing bytes do not match the rendered intent";
  } catch (error) {
    if (error.name !== "IntentRenderRefusal") throw error;
    refusal = error.message;
  }
  lineTampering.push({ name, from: reference.name, edit, lines, expected: { refusal } });
}
const document = {
  format: "zyronchain/intent-render-vectors",
  rendererVersion: RENDERER_VERSION,
  note: "Generated by l1/scripts/generate-intent-render-vectors.mjs. Shared by the l1, PWA and Snap renderers.",
  signer: { privateKeyHex: senderKey, publicKey, address: sender },
  cases,
  lineTampering
};
await writeFile(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${cases.length} cases and ${lineTampering.length} line-tampering cases`);
