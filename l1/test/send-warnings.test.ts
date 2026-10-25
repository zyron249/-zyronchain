import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

import {
  LOOKALIKE_MAX_COMPARISONS,
  LOOKALIKE_MAX_DIFF,
  LOOKALIKE_MAX_MATCHES,
  LOOKALIKE_MIN_SHARED,
  SELF_SEND_MESSAGE,
  addressDiff,
  displayAddress,
  groupAddress,
  lookalikeMatches,
  parseKnownAddresses,
  sendWarnings
} from "../src/send-warnings.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const cliPath = resolve(here, "../src/cli.js");
const run = promisify(execFile);

const OWN = "ZYN1111111111111111111111111111111111111111";
const CONTACT = "ZYNabcd00000000000000000000000000000000ef12";
// Same first 4 and last 4 hex as CONTACT, different middle: the address-poisoning pattern.
const POISON = "ZYNabcd99999999999999999999999999999999ef12";
// One hex character away from CONTACT.
const TYPO = "ZYNabcd00000000000000000000000000000000ef13";
const STRANGER = "ZYN5d99ee966b42cd8fc7bdd1364b389153a9e78b42";

function book(overrides: Partial<{ contacts: Array<{ name: string; address: string }>; sent: string[]; thresholdAtoms: number | null }> = {}) {
  return parseKnownAddresses({ contacts: [{ name: "Alice", address: CONTACT }], sent: [], thresholdAtoms: null, ...overrides });
}

test("send-warnings: lookalike rule constants match the decided PWA defaults", () => {
  assert.equal(LOOKALIKE_MIN_SHARED, 6);
  assert.equal(LOOKALIKE_MAX_DIFF, 2);
  assert.equal(LOOKALIKE_MAX_COMPARISONS, 250);
  assert.equal(LOOKALIKE_MAX_MATCHES, 3);
});

test("send-warnings: grouped checksummed display", () => {
  assert.equal(displayAddress("ZYN09c0b2d1a486c439a87bcba6b46a7a1a23f3897c"), "ZYN 09C0 B2D1 A486 C439 A87b CbA6 b46A 7a1A 23F3 897c");
  assert.equal(groupAddress("ZYN0000000000000000000000000000000000000000"), "ZYN 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000");
  assert.throws(() => displayAddress("ZYN09C0b2d1a486c439a87bcba6b46a7a1a23f3897c"), /checksum/i);
  assert.deepEqual(addressDiff(CONTACT, TYPO), [39]);
});

test("send-warnings: prefix/suffix lookalike of a contact warns, exact match does not", () => {
  const look = lookalikeMatches(POISON, book());
  assert.equal(look.matches.length, 1);
  assert.equal(look.matches[0]!.address, CONTACT);
  assert.equal(look.matches[0]!.source, "contact");
  assert.equal(look.matches[0]!.prefix, 4);
  assert.equal(look.matches[0]!.suffix, 4);
  assert.equal(lookalikeMatches(CONTACT, book()).matches.length, 0);
  assert.equal(lookalikeMatches(STRANGER, book()).matches.length, 0);
  assert.equal(lookalikeMatches(TYPO, book()).matches.length, 1, "small edit distance warns");
  const warnings = sendWarnings({ receiver: POISON, amountAtoms: 1 }, { address: OWN }, book());
  const codes = warnings.map((w) => w.code);
  assert.deepEqual(codes, ["lookalike", "first-time"]);
  assert.equal(warnings[0]!.blocking, false, "lookalike is acknowledge-only");
});

test("send-warnings: lookalike of a history address warns even though history cannot be poisoned", () => {
  const look = lookalikeMatches(POISON, book({ contacts: [], sent: [CONTACT] }));
  assert.equal(look.matches[0]!.source, "history");
});

test("send-warnings: self-send is blocking and short-circuits", () => {
  const warnings = sendWarnings({ receiver: OWN, amountAtoms: 1 }, { address: OWN }, book());
  assert.deepEqual(warnings, [{ code: "self", blocking: true, message: SELF_SEND_MESSAGE }]);
});

test("send-warnings: first-time and large-amount warnings", () => {
  const known = book({ sent: [STRANGER], thresholdAtoms: 1_000 });
  assert.deepEqual(sendWarnings({ receiver: STRANGER, amountAtoms: 999 }, { address: OWN }, known), []);
  assert.deepEqual(sendWarnings({ receiver: STRANGER, amountAtoms: 1_000 }, { address: OWN }, known).map((w) => w.code), ["large-amount"]);
});

test("send-warnings: comparisons and matches are capped", () => {
  const sent: string[] = [];
  for (let i = 0; i < 200; i += 1) sent.push(`ZYNabcd${i.toString(16).padStart(30, "0")}00ef12`);
  const contacts = [];
  for (let i = 0; i < 100; i += 1) contacts.push({ name: `c${i}`, address: `ZYN${(i + 0x1000).toString(16).padStart(40, "7")}` });
  const look = lookalikeMatches(POISON, book({ contacts, sent }));
  assert.equal(look.compared, LOOKALIKE_MAX_COMPARISONS);
  assert.equal(look.truncated, true);
  assert.equal(look.matches.length, LOOKALIKE_MAX_MATCHES);
});

test("send-warnings: known-address input is validated strictly", () => {
  assert.throws(() => parseKnownAddresses({ contacts: [], sent: ["nope"], thresholdAtoms: null }));
  assert.throws(() => parseKnownAddresses({ contacts: [], sent: [], thresholdAtoms: 0 }));
  assert.throws(() => parseKnownAddresses({ contacts: [], sent: [], thresholdAtoms: null, extra: 1 }));
  assert.throws(() => parseKnownAddresses({ contacts: [{ name: "", address: CONTACT }], sent: [], thresholdAtoms: null }));
  assert.throws(() => parseKnownAddresses({ contacts: [], sent: new Array(201).fill(CONTACT), thresholdAtoms: null }));
  assert.throws(() => parseKnownAddresses({ contacts: [], sent: [CONTACT, CONTACT], thresholdAtoms: null }), /history/);
  assert.throws(() => parseKnownAddresses({ contacts: [], sent: ["ZYNABCD00000000000000000000000000000000EF12"], thresholdAtoms: null }), /history/, "stored addresses are canonical only");
  assert.deepEqual(parseKnownAddresses({ contacts: [], sent: [CONTACT], thresholdAtoms: null }).sent, [CONTACT]);
});

test("send-warnings: matches the PWA wallet core byte for byte", async () => {
  const ctx: Record<string, unknown> = { crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of ["website/app/vendor/noble-scure.js", "website/app/zyron-wallet-core.js"]) {
    vm.runInContext(await readFile(join(repoRoot, file), "utf8"), ctx);
  }
  const pwa = ctx.ZyronAppCore as {
    sendWarnings: (input: unknown, account: unknown, book: unknown) => unknown;
    lookalikeMatches: (receiver: string, book: unknown) => unknown;
    displayAddress: (address: string) => string;
  };
  // Objects must be created inside the PWA realm so its plain-object checks accept them.
  const inCtx = (value: unknown): unknown => vm.runInContext(`(${JSON.stringify(value)})`, ctx);
  const raw = { contacts: [{ name: "Alice", address: CONTACT }], sent: [STRANGER], thresholdAtoms: 500 };
  for (const receiver of [POISON, TYPO, CONTACT, STRANGER, OWN]) {
    for (const amountAtoms of [1, 500]) {
      assert.deepEqual(
        JSON.parse(JSON.stringify(sendWarnings({ receiver, amountAtoms }, { address: OWN }, parseKnownAddresses(raw)))),
        JSON.parse(JSON.stringify(pwa.sendWarnings(inCtx({ receiver, amountAtoms }), inCtx({ address: OWN }), inCtx(raw)))),
        `${receiver} ${amountAtoms}`
      );
    }
    assert.deepEqual(
      JSON.parse(JSON.stringify(lookalikeMatches(receiver, parseKnownAddresses(raw)))),
      JSON.parse(JSON.stringify(pwa.lookalikeMatches(receiver, inCtx(raw))))
    );
    assert.equal(displayAddress(receiver), pwa.displayAddress(receiver));
  }
});

test("send-warnings: CLI send-check is offline and advisory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-send-check-"));
  try {
    const file = join(dir, "known.json");
    await writeFile(file, JSON.stringify({ contacts: [{ name: "Alice", address: CONTACT }], sent: [], thresholdAtoms: null }));
    const { stdout } = await run(process.execPath, [cliPath, "send-check", "--to", POISON, "--from", OWN, "--amount-atoms", "5", "--known-file", file, "--format", "json"]);
    const out = JSON.parse(stdout) as { receiver: string; display: string; warnings: Array<{ code: string; blocking: boolean }> };
    assert.equal(out.receiver, POISON);
    assert.equal(out.display, displayAddress(POISON));
    assert.deepEqual(out.warnings.map((w) => w.code), ["lookalike", "first-time"]);
    const human = await run(process.execPath, [cliPath, "send-check", "--to", POISON, "--known-file", file]);
    assert.match(human.stdout, /WARNING \(lookalike\)/);
    assert.match(human.stdout, /ZYN abcd 9999/i);
    await assert.rejects(run(process.execPath, [cliPath, "send-check", "--to", OWN, "--from", OWN]), /own address/);
    await assert.rejects(run(process.execPath, [cliPath, "send-check", "--to", POISON, "--rpc", "http://127.0.0.1:1"]), /Unknown option|unknown option/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("send-warnings: own address is normalized before the self-send check (library and PWA copies)", async () => {
  const ctx: Record<string, unknown> = { crypto: globalThis.crypto, TextEncoder, TextDecoder, Uint8Array };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  for (const file of ["website/app/vendor/noble-scure.js", "website/app/zyron-wallet-core.js"]) {
    vm.runInContext(await readFile(join(repoRoot, file), "utf8"), ctx);
  }
  const pwa = ctx.ZyronAppCore as { sendWarnings: (input: unknown, account: unknown, book: unknown) => Array<{ code: string; blocking: boolean }> };
  const inCtx = (value: unknown): unknown => vm.runInContext(`(${JSON.stringify(value)})`, ctx);
  const raw = { contacts: [], sent: [], thresholdAtoms: null };
  const checksummed = displayAddress(STRANGER).replace(/ /g, "");
  assert.notEqual(checksummed, STRANGER, "fixture must differ from the canonical form");
  for (const own of [checksummed, STRANGER]) {
    const lib = sendWarnings({ receiver: STRANGER }, { address: own }, parseKnownAddresses(raw));
    assert.deepEqual(lib.map((w) => [w.code, w.blocking]), [["self", true]], `library ${own}`);
    const web = pwa.sendWarnings(inCtx({ receiver: STRANGER }), inCtx({ address: own }), inCtx(raw));
    assert.deepEqual(JSON.parse(JSON.stringify(web.map((w) => [w.code, w.blocking]))), [["self", true]], `pwa ${own}`);
  }
  // An invalid own address fails closed in both copies.
  const bad = "ZYN" + STRANGER.slice(3).toUpperCase().replace(/^5D/, "5d");
  assert.throws(() => sendWarnings({ receiver: STRANGER }, { address: bad }, parseKnownAddresses(raw)));
  assert.throws(() => sendWarnings({ receiver: STRANGER }, { address: "not-an-address" }, parseKnownAddresses(raw)));
  assert.throws(() => pwa.sendWarnings(inCtx({ receiver: STRANGER }), inCtx({ address: "not-an-address" }), inCtx(raw)));
});

test("send-warnings: CLI send-check notes when the known-address list was truncated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zyron-send-check-trunc-"));
  try {
    const file = join(dir, "known.json");
    const addr = (i: number) => "ZYN" + (i + 1).toString(16).padStart(8, "0").repeat(5);
    const contacts = Array.from({ length: 100 }, (_, i) => ({ name: `C${i}`, address: addr(i) }));
    const sent = Array.from({ length: 160 }, (_, i) => addr(100 + i));
    await writeFile(file, JSON.stringify({ contacts, sent, thresholdAtoms: null }));
    const human = await run(process.execPath, [cliPath, "send-check", "--to", STRANGER, "--known-file", file]);
    assert.match(human.stdout, new RegExp(`note: only the first ${LOOKALIKE_MAX_COMPARISONS} of 260 known addresses were compared`));
    const small = join(dir, "small.json");
    await writeFile(small, JSON.stringify({ contacts: [], sent: sent.slice(0, 3), thresholdAtoms: null }));
    const quiet = await run(process.execPath, [cliPath, "send-check", "--to", STRANGER, "--known-file", small]);
    assert.doesNotMatch(quiet.stdout, /only the first/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
