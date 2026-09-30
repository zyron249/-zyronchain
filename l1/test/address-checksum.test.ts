import assert from "node:assert/strict";
import test from "node:test";

import { parseAddressInput, toChecksumAddress } from "../src/address-checksum.js";
import { addressFromPublicKey, generatePrivateKey, publicKeyFromPrivate } from "../src/crypto.js";
import { passwordStrength } from "../src/password-prompt.js";

// Shared with website/test-wallet-core.mjs.
export const CHECKSUM_VECTORS: Array<[string, string]> = [
  ["ZYN09c0b2d1a486c439a87bcba6b46a7a1a23f3897c", "ZYN09C0B2D1A486C439A87bCbA6b46A7a1A23F3897c"],
  ["ZYN5d99ee966b42cd8fc7bdd1364b389153a9e78b42", "ZYN5D99EE966b42cD8fC7bdD1364B389153A9E78B42"],
  ["ZYN8fb16cd1fbcedbd367eb258df0a7c40b7225c87a", "ZYN8fB16Cd1FbCEDBd367Eb258Df0A7c40b7225C87A"],
  ["ZYN5cb032e51cee3b6ba053648fcdb806aaabf92df6", "ZYN5cB032e51Cee3b6Ba053648FcDb806aaaBF92Df6"],
  ["ZYN80636eaa7a0a54ad4e369e0b6c6f08ead6a49448", "ZYN80636Eaa7A0A54ad4E369E0b6C6F08eAd6a49448"],
  ["ZYNffffffffffffffffffffffffffffffffffffffff", "ZYNFfFFFfFFfFfFfffFFFfFffFFFfffFFfFfFfFFfFf"],
  ["ZYN0000000000000000000000000000000000000000", "ZYN0000000000000000000000000000000000000000"]
];

test("display checksum vectors and canonical round-trip", () => {
  for (const [canonical, checksummed] of CHECKSUM_VECTORS) {
    assert.equal(toChecksumAddress(canonical), checksummed);
    assert.deepEqual(parseAddressInput(checksummed).canonical, canonical);
    assert.equal(parseAddressInput(canonical).checksumVerified, false, "plain lower-case stays valid");
    assert.equal(checksummed.toLowerCase().replace(/^zyn/, "ZYN"), canonical, "lower-casing yields the consensus form");
  }
  assert.equal(parseAddressInput(CHECKSUM_VECTORS[0]![1]).checksumVerified, true);
});

test("checksum catches case and character typos; malformed input is rejected", () => {
  const [canonical, checksummed] = CHECKSUM_VECTORS[0]!;
  const caseFlipped = checksummed.slice(0, 5) + (checksummed[5] === checksummed[5]!.toUpperCase() ? checksummed[5]!.toLowerCase() : checksummed[5]!.toUpperCase()) + checksummed.slice(6);
  assert.notEqual(caseFlipped, checksummed);
  assert.throws(() => parseAddressInput(caseFlipped), /checksum mismatch/);
  assert.throws(() => parseAddressInput(`ZYN${canonical.slice(3).toUpperCase()}`), /checksum mismatch/);
  assert.throws(() => toChecksumAddress(checksummed), /canonical/);
  for (const bad of ["zyn09c0b2d1a486c439a87bcba6b46a7a1a23f3897c", `${canonical}0`, canonical.slice(0, -1), `${canonical.slice(0, -1)}g`, ""]) {
    assert.throws(() => parseAddressInput(bad), /Invalid address/);
  }
  // A single-character typo in a checksummed address is detected unless the typo only touches digits
  // AND the new hash happens to agree on every letter (probability ~2^-letters).
  let detected = 0;
  let total = 0;
  for (let index = 0; index < 200; index += 1) {
    const address = addressFromPublicKey(publicKeyFromPrivate(generatePrivateKey()));
    const shown = toChecksumAddress(address);
    const position = 3 + (index % 40);
    const replacement = shown[position] === "7" ? "8" : "7";
    const typo = shown.slice(0, position) + replacement + shown.slice(position + 1);
    total += 1;
    try { parseAddressInput(typo); } catch { detected += 1; }
  }
  assert.ok(detected / total > 0.97, `checksum detected ${detected}/${total} single-character typos`);
});

test("password strength check: length, repetition and ~60-bit estimate", () => {
  assert.equal(passwordStrength("short").ok, false);
  assert.match(passwordStrength("aaaaaaaaaaaaaaaa").reason, /repetitive/);
  assert.match(passwordStrength("abcdefghijkl").reason, /too weak/);
  assert.equal(passwordStrength("correct horse battery staple").ok, true);
  assert.equal(passwordStrength("Tr0ub4dor&3xyz").ok, true);
  assert.equal(passwordStrength("a-strong-local-wallet-password").ok, true);
  assert.equal(passwordStrength("şifrem-çok-güçlü-2026").ok, true);
});
