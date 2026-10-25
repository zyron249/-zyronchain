#!/usr/bin/env node
// Regenerates l1/test/vectors/intent-render-v1.json from the l1 renderer (feature 6A).
// Usage (from l1/): npm run build && node scripts/generate-intent-render-vectors.mjs
// The output is deterministic: fixed keys, fixed timestamps, no clock or randomness.
import { writeFile } from "node:fs/promises";
import { canonicalJson } from "../dist/src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../dist/src/crypto.js";
import { toChecksumAddress } from "../dist/src/address-checksum.js";
import { RENDERER_VERSION, TRANSFER_INTENT_DOMAIN, renderIntent } from "../dist/src/intent-render.js";

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
  ["non-ASCII chain ID", { chainId: "zyron-testnet-\u00e9" }],
  ["control character in chain ID", { chainId: "zyron-testnet-1\u0000" }],
  ["bidi override in chain ID", { chainId: "zyron-\u202etestnet-1" }],
  ["mixed-case payload receiver (R2)", { receiver: mixed(receiver) }],
  ["mixed-case payload sender (R2)", { sender: mixed(sender) }],
  ["upper-case hex receiver (R2)", { receiver: `ZYN${receiver.slice(3).toUpperCase()}` }],
  ["bad address", { receiver: "ZYNnot-an-address" }],
  ["reserved receiver", { receiver: `ZYN${"0".repeat(40)}` }],
  ["sender not derived from publicKey", { sender: receiver }],
  ["invalid public key", { publicKey: "00".repeat(64) }]
];

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
  const domain = domainOverride ?? TRANSFER_INTENT_DOMAIN;
  let refusal;
  try {
    renderIntent({ domain, payload });
  } catch (error) {
    if (error.name !== "IntentRenderRefusal") throw error;
    refusal = error.message;
  }
  if (!refusal) throw new Error(`refusal vector "${name}" rendered`);
  let signingBytesHex = null; // null: the payload is not even canonical-JSON encodable
  try { signingBytesHex = hex({ domain, payload }); } catch { /* keep null */ }
  cases.push({ name, domain, payload, signingBytesHex, expected: { refusal } });
}
const document = {
  format: "zyronchain/intent-render-vectors",
  rendererVersion: RENDERER_VERSION,
  note: "Generated by l1/scripts/generate-intent-render-vectors.mjs. Shared by the l1, PWA and Snap renderers.",
  signer: { privateKeyHex: senderKey, publicKey, address: sender },
  cases
};
await writeFile(out, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${cases.length} cases`);
