import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { toChecksumAddress, parseAddressInput } from "../src/address-checksum.js";
import { canonicalJson } from "../src/codec.js";
import { addressFromPublicKey, publicKeyFromPrivate, verifyCanonicalDomain } from "../src/crypto.js";
import {
  CHAIN_ID_RE,
  IntentRenderRefusal,
  RENDERER_VERSION,
  RENDERABLE_KINDS,
  RENDERABLE_CHAIN_IDS,
  TRANSFER_INTENT_DOMAIN,
  assertRenderMatchesSigningBytes,
  formatAtoms,
  formatTimestampMs,
  isAllowedTestnetChainId,
  parseRenderedLines,
  signingBytesFor,
  renderIntent,
  type RenderedIntent
} from "../src/intent-render.js";
import { createTransfer, signTransfer, transactionSigningDomain, validateTransactionShape } from "../src/transaction.js";
import { MAX_SUPPLY_ATOMS } from "../src/types.js";

interface VectorCase {
  name: string;
  domain: string;
  payload: Record<string, unknown>;
  userInputReceiver?: string;
  signingBytesHex: string | null;
  expected: { lines: { label: string; value: string }[]; text: string } | { refusal: string };
}
interface LineTamperingCase {
  name: string;
  from: string;
  lines: { label: string; value: string }[];
  expected: { refusal: string };
}
interface VectorFile {
  rendererVersion: number;
  signer: { privateKeyHex: string; publicKey: string; address: string };
  cases: VectorCase[];
  lineTampering: LineTamperingCase[];
}

/** Rebuilds a vector payload with the non-plain prototype named by its `construct` field (see the generator). */
function constructPayload(payload: Record<string, unknown>): unknown {
  const { construct, ...fields } = payload;
  if (construct === undefined) return payload;
  if (construct === "null-prototype") return Object.assign(Object.create(null) as object, fields);
  if (construct === "class-instance") return Object.assign(new (class TransferLike {})(), fields);
  if (construct === "array") return Object.assign([], fields);
  throw new Error(`unknown construct ${String(construct)}`);
}

const vectors = JSON.parse(await readFile(new URL("../../test/vectors/intent-render-v1.json", import.meta.url), "utf8")) as VectorFile;
const privateKey = vectors.signer.privateKeyHex;
const publicKey = publicKeyFromPrivate(privateKey);
const sender = addressFromPublicKey(publicKey);
const otherPrivate = "6b".padStart(64, "0");
const receiver = addressFromPublicKey(publicKeyFromPrivate(otherPrivate));

function payload(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "transfer", version: 2, chainId: "zyron-open-testnet-1", nonce: 7, sender, receiver,
    amountAtoms: 150_000_000, feeAtoms: 100_000, timestampMs: 1_761_408_000_000, publicKey, ...patch
  };
}
function render(patch: Record<string, unknown> = {}, domain = TRANSFER_INTENT_DOMAIN): RenderedIntent {
  return renderIntent({ domain, payload: payload(patch) });
}

test("intent-render: RENDERER_VERSION is 1 and the kind allowlist is transfer only", () => {
  assert.equal(RENDERER_VERSION, 1);
  assert.equal(vectors.rendererVersion, RENDERER_VERSION);
  assert.deepEqual([...RENDERABLE_KINDS], ["transfer"]);
  assert.equal(TRANSFER_INTENT_DOMAIN, transactionSigningDomain("transfer"));
  for (const kind of ["activity_settlement", "mining_claim", "validator_update", "activity_oracle_governance", "protocol_upgrade", "message"]) {
    assert.throws(() => render({ kind }), IntentRenderRefusal, kind);
  }
});

test("intent-render vectors: every valid case renders exactly and round-trips to the signing bytes and amounts", () => {
  let valid = 0;
  for (const vector of vectors.cases) {
    if (!("lines" in vector.expected)) continue;
    valid += 1;
    const rendered = renderIntent({ domain: vector.domain, payload: vector.payload });
    assert.deepEqual(rendered.lines.map((line) => ({ ...line })), vector.expected.lines, vector.name);
    assert.equal(rendered.text, vector.expected.text, vector.name);
    assert.equal(rendered.signingBytesHex, vector.signingBytesHex, vector.name);
    assert.equal(Buffer.from(canonicalJson({ domain: vector.domain, payload: vector.payload }), "utf8").toString("hex"), vector.signingBytesHex);
    const amount = /^Amount: [0-9.]+ ZYN \(([0-9]+) atoms\)$/m.exec(rendered.text);
    const fee = /^Fee: [0-9.]+ ZYN \(([0-9]+) atoms\)$/m.exec(rendered.text);
    assert.equal(Number(amount?.[1]), vector.payload.amountAtoms, vector.name);
    assert.equal(Number(fee?.[1]), vector.payload.feeAtoms, vector.name);
    assert.match(rendered.text, /^[\x20-\x7e\n]+$/, "ASCII only");
  }
  assert.ok(valid >= 8);
});

test("intent-render vectors: every refusal case is refused with the recorded reason", () => {
  let refused = 0;
  for (const vector of vectors.cases) {
    if (!("refusal" in vector.expected)) continue;
    refused += 1;
    assert.throws(
      () => renderIntent({ domain: vector.domain, payload: constructPayload(vector.payload) }),
      (error: unknown) => error instanceof IntentRenderRefusal && error.message === (vector.expected as { refusal: string }).refusal,
      vector.name
    );
  }
  assert.ok(refused >= 50);
  // Security L4: the refusal classes that must stay covered by the shared vectors.
  const names = vectors.cases.map((vector) => vector.name);
  for (const required of [
    "non-plain prototype (null prototype)", "non-plain prototype (class instance)", "non-string publicKey (number)",
    "non-string domain (number)", "non-ASCII domain", "unsafe nonce", "wrong type nonce (string)", "unsafe fee",
    "wrong type fee (string)", "unsafe timestamp", "wrong type timestamp (string)",
    "mainnet token before testnet (R3 fixed list)", "mainnet-devnet (R3 fixed list)", "devnet-mainnet-1 (R3 fixed list)", "bare testnet (R3 fixed list)"
  ]) {
    assert.ok(names.includes(required), required);
  }
});

test("intent-render vectors: every rendered-line tampering case is refused or rebuilds different bytes", () => {
  assert.ok(vectors.lineTampering.length >= 12);
  for (const vector of vectors.lineTampering) {
    const reference = vectors.cases.find((entry) => entry.name === vector.from);
    assert.ok(reference?.signingBytesHex, vector.name);
    let refusal: string | undefined;
    try {
      const parsed = parseRenderedLines(vector.lines);
      if (Buffer.from(signingBytesFor(parsed.domain, parsed.payload)).toString("hex") !== reference.signingBytesHex) {
        refusal = "Refusing to sign: signing bytes do not match the rendered intent";
      }
    } catch (error) {
      assert.ok(error instanceof IntentRenderRefusal, vector.name);
      refusal = error.message;
    }
    assert.equal(refusal, vector.expected.refusal, vector.name);
  }
});

test("R1 single signing path: signTransfer signs exactly the renderer-rebuilt bytes and nothing else", () => {
  const rendered = render();
  assert.equal(signTransfer.length, 2, "signTransfer(rendered, privateKey) has no payload parameter");
  const tx = signTransfer(rendered, privateKey);
  validateTransactionShape(tx);
  assert.equal(tx.version, 2);
  const signedBytes = Buffer.from(canonicalJson({ domain: rendered.domain, payload: rendered.payload }), "utf8").toString("hex");
  assert.equal(signedBytes, rendered.signingBytesHex);
  assert.ok(verifyCanonicalDomain(rendered.domain, rendered.payload, tx.signature, publicKey));
  const { signature: _s, txid: _t, ...unsigned } = tx;
  assert.deepEqual(unsigned, { ...rendered.payload });
  assert.ok(Object.isFrozen(rendered) && Object.isFrozen(rendered.payload) && Object.isFrozen(rendered.lines));
});

test("R1 single signing path: hand-built, copied or edited RenderedIntents are refused", () => {
  const rendered = render();
  assert.throws(() => signTransfer({ ...rendered }, privateKey), IntentRenderRefusal);
  assert.throws(() => signTransfer({ ...rendered, payload: { ...rendered.payload, amountAtoms: 999 } } as RenderedIntent, privateKey), IntentRenderRefusal);
  assert.throws(() => signTransfer(JSON.parse(JSON.stringify(rendered)) as RenderedIntent, privateKey), IntentRenderRefusal);
  assert.throws(() => signTransfer(payload() as unknown as RenderedIntent, privateKey), IntentRenderRefusal);
  assert.throws(() => { (rendered.payload as { amountAtoms: number }).amountAtoms = 1; }, TypeError);
});

test("R1 single signing path: assertRenderMatchesSigningBytes refuses any other bytes", () => {
  const rendered = render();
  const bytes = Uint8Array.from(Buffer.from(rendered.signingBytesHex, "hex"));
  assert.doesNotThrow(() => assertRenderMatchesSigningBytes(rendered, bytes));
  const other = Buffer.from(canonicalJson({ domain: TRANSFER_INTENT_DOMAIN, payload: payload({ amountAtoms: 150_000_001 }) }), "utf8");
  assert.throws(() => assertRenderMatchesSigningBytes(rendered, Uint8Array.from(other)), IntentRenderRefusal);
  const v1Bytes = Buffer.from(canonicalJson(payload()), "utf8");
  assert.throws(() => assertRenderMatchesSigningBytes(rendered, Uint8Array.from(v1Bytes)), IntentRenderRefusal);
});

test("R1 single signing path: rendered lines that disagree with each other cannot be parsed back", () => {
  const lines = render().lines.map((line) => ({ ...line }));
  lines[7] = { label: "Total", value: "9 ZYN (900000000 atoms)" };
  assert.throws(() => parseRenderedLines(lines), IntentRenderRefusal);
  const swapped = render().lines.map((line) => ({ ...line }));
  swapped[5] = { label: "Amount", value: "2 ZYN (150000000 atoms)" };
  assert.throws(() => parseRenderedLines(swapped), IntentRenderRefusal);
  assert.throws(() => parseRenderedLines(render().lines.slice(0, 11)), IntentRenderRefusal);
});

test("R1 single signing path: CLI signers never reach a signing primitive except through signTransfer(rendered)", async () => {
  const cli = await readFile(new URL("../../src/cli.ts", import.meta.url), "utf8");
  // Security L2: no namespace import of transaction.js or crypto.js (no aliased or computed access).
  assert.doesNotMatch(cli, /import\s+\*\s+as\s+\w+\s+from\s+["']\.\/(transaction|crypto)\.js["']/);
  assert.doesNotMatch(cli, /import\s*\(\s*["'`]\.\/(transaction|crypto)\.js/, "no dynamic import of transaction.js or crypto.js");
  const named = (module: string) => [...cli.matchAll(new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from\\s*["']\\./${module}\\.js["']`, "g"))]
    .flatMap((match) => match[1]!.split(",").map((name) => name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]!).filter(Boolean));
  const imported = [...named("transaction"), ...named("crypto")];
  assert.ok(imported.includes("signTransfer"));
  for (const forbidden of ["createTransfer", "signCanonicalDomain", "signCanonical", "signMessageBytes"]) {
    assert.equal(imported.includes(forbidden), false, `cli.ts imports ${forbidden}`);
    assert.doesNotMatch(cli, new RegExp(`\\b${forbidden}\\b`), `cli.ts names ${forbidden}`);
  }
  // Both wallet commands render, confirm and sign through the single path.
  assert.equal((cli.match(/const rendered = await renderAndConfirmTransfer\(args, yes, \{/g) ?? []).length, 2);
  assert.equal((cli.match(/const tx = signTransfer\(rendered, key\);/g) ?? []).length, 2);
});

test("R2 canonical input only: mixed-case payload addresses are refused, never normalized", () => {
  const checksummedReceiver = toChecksumAddress(receiver);
  const checksummedSender = toChecksumAddress(sender);
  assert.notEqual(checksummedReceiver, receiver);
  assert.throws(() => render({ receiver: checksummedReceiver }), /receiver is not in canonical lower-case form/);
  assert.throws(() => render({ sender: checksummedSender }), /sender is not in canonical lower-case form/);
  assert.throws(() => render({ receiver: `ZYN${receiver.slice(3).toUpperCase()}` }), IntentRenderRefusal);
  // Normalization happens only at user input, before the payload is built.
  const normalized = parseAddressInput(checksummedReceiver).canonical;
  assert.equal(render({ receiver: normalized }).payload.receiver, receiver);
  const inputVector = vectors.cases.find((vector) => vector.userInputReceiver !== undefined);
  assert.ok(inputVector);
  assert.equal(parseAddressInput(inputVector.userInputReceiver!).canonical, inputVector.payload.receiver);
});

test("R3 chainId allowlist: a fixed list of chain IDs, identical to the PWA list; everything else is refused", async () => {
  assert.deepEqual([...RENDERABLE_CHAIN_IDS], ["zyron-devnet-1", "zyron-wallet-testnet-1", "zyron-open-testnet-1"]);
  assert.ok(Object.isFrozen(RENDERABLE_CHAIN_IDS));
  const pwa = await readFile(new URL("../../../website/app/zyron-wallet-core.js", import.meta.url), "utf8");
  const pwaList = /const RENDERABLE_CHAIN_IDS = Object\.freeze\(\[([^\]]*)\]\);/.exec(pwa);
  assert.ok(pwaList, "the PWA declares RENDERABLE_CHAIN_IDS");
  assert.deepEqual([...pwaList[1]!.matchAll(/'([^']+)'/g)].map((match) => match[1]), [...RENDERABLE_CHAIN_IDS]);
  assert.match(CHAIN_ID_RE.source, /^\^\[a-z0-9-\]\{3,64\}\$$/);
  for (const id of RENDERABLE_CHAIN_IDS) {
    assert.equal(isAllowedTestnetChainId(id), true, id);
    assert.doesNotThrow(() => render({ chainId: id }), id);
  }
  for (const id of [
    "zyron-mainnet-1", "zyron-mainnet-testnet", "mainnet-devnet", "devnet-mainnet-1", "testnet", "devnet", "zyron-mainnet-1-testnet",
    "zyron-public-testnet-1", "zyron-testnet-1", "zyron-devnet-2", "devnet-abc", "zyron-1", "zyron-cli-v5", "ZYRON-DEVNET-1", "zyron-devnet-1 ", ""
  ]) {
    assert.equal(isAllowedTestnetChainId(id), false, id);
    assert.throws(() => render({ chainId: id }), IntentRenderRefusal, id);
  }
});

test("R4 publicKey binding: the signer refuses a payload that is not bound to its own key", () => {
  const rendered = render();
  assert.throws(() => signTransfer(rendered, otherPrivate), /payload publicKey is not this signer's key/);
  assert.throws(() => render({ sender: receiver }), /sender is not derived from publicKey/);
  assert.throws(() => render({ publicKey: publicKeyFromPrivate(otherPrivate) }), /sender is not derived from publicKey/);
  assert.throws(() => signTransfer(rendered, "00".repeat(32)), IntentRenderRefusal);
});

test("resolved 1: version 1 is refused by the renderer while consensus still accepts version 1", () => {
  assert.throws(() => render({ version: 1 }), /transaction version 1/);
  const legacy = createTransfer(
    { chainId: "zyron-devnet-1", nonce: 1, sender, receiver, amountAtoms: 5, feeAtoms: 0, timestampMs: 1 },
    privateKey, publicKey, 1
  );
  assert.equal(legacy.version, 1);
  assert.doesNotThrow(() => validateTransactionShape(legacy));
});

test("resolved 2: Number.isSafeInteger is checked before BigInt and the total is computed in BigInt", () => {
  for (const bad of ["1", 1n, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 2, null, {}]) {
    assert.throws(() => render({ amountAtoms: bad }), IntentRenderRefusal, String(bad));
    assert.throws(() => render({ feeAtoms: bad }), IntentRenderRefusal, String(bad));
  }
  const rendered = render({ amountAtoms: MAX_SUPPLY_ATOMS - 1, feeAtoms: 1 });
  assert.equal(rendered.lines[7]!.value, "50000000 ZYN (5000000000000000 atoms)");
  assert.equal(formatAtoms(9_007_199_254_740_993n), "90071992.54740993 ZYN (9007199254740993 atoms)");
  assert.equal(formatAtoms(1n), "0.00000001 ZYN (1 atoms)");
  assert.equal(formatAtoms(100_000_000n), "1 ZYN (100000000 atoms)");
});

test("intent-render: integer-only ISO timestamps agree with Date across the renderable range", () => {
  let seed = 0x6a6a6a6a;
  const next = () => { seed = (seed * 1_103_515_245 + 12_345) >>> 0; return seed; };
  const samples = [0, 1, 951_782_400_000, 4_107_542_400_000, 253_402_300_799_999];
  for (let index = 0; index < 500; index += 1) samples.push((next() * 59_000) % 253_402_300_800_000);
  for (const ms of samples) {
    assert.equal(formatTimestampMs(ms), `${ms} ms (${new Date(ms).toISOString()})`, String(ms));
  }
});

test("intent-render property: random valid transfers render, round-trip and sign", () => {
  let seed = 0x1234_5678;
  const next = (limit: number) => { seed = (seed * 1_664_525 + 1_013_904_223) >>> 0; return seed % limit; };
  for (let index = 0; index < 200; index += 1) {
    const amountAtoms = 1 + next(1_000_000) * next(1_000_000) % (MAX_SUPPLY_ATOMS - 200_000);
    const feeAtoms = next(200_000);
    const rendered = render({ amountAtoms, feeAtoms, nonce: 1 + next(1_000_000), timestampMs: next(2_000_000_000) * 1_000 });
    const parsed = parseRenderedLines(rendered.lines);
    assert.deepEqual(parsed.payload, { ...rendered.payload });
    assert.equal(parsed.payload.amountAtoms, amountAtoms);
    assert.equal(parsed.payload.feeAtoms, feeAtoms);
    if (index % 20 === 0) validateTransactionShape(signTransfer(rendered, privateKey));
  }
});

/** Returns the transfer-named intents in a remote-signer source that lack renderIntent. */
/**
 * Security L3: the exact remote-signer intents reviewed for 6A. None of them is a wallet spend.
 * Adding, removing or renaming ANY intent fails until this list is updated in review (no comment
 * or keyword matching: a transfer intent needs a renderIntent path and a new 6A review).
 */
export const REVIEWED_REMOTE_SIGNER_INTENTS: readonly string[] = Object.freeze([
  "block-proposal", "block-attestation", "round-skip", "consensus-proposal", "prepare-vote", "commit-vote", "round-timeout"
]);

/** Returns the KNOWN_INTENTS entries, refusing anything but a plain list of string literals. */
export function knownRemoteSignerIntents(source: string): string[] {
  const matches = [...source.matchAll(/const KNOWN_INTENTS\b[^=]*=\s*new Set(?:<[^>]*>)?\(\[([\s\S]*?)\]\)/g)];
  if (matches.length !== 1) throw new Error("expected exactly one KNOWN_INTENTS declaration in remote-signer-service.ts");
  const body = matches[0]![1]!;
  if (body.replace(/"[a-z-]+"/g, "").replace(/[\s,]/g, "") !== "") throw new Error("KNOWN_INTENTS must be a plain list of string literals");
  if ((source.match(/\bKNOWN_INTENTS\b/g) ?? []).length !== 2) throw new Error("KNOWN_INTENTS must be declared once and only read by has()");
  return [...body.matchAll(/"([a-z-]+)"/g)].map((item) => item[1]!);
}

test("resolved 6: remote-signer KNOWN_INTENTS equals the reviewed allowlist exactly (no transfer intent)", async () => {
  const source = await readFile(new URL("../../src/remote-signer-service.ts", import.meta.url), "utf8");
  assert.deepEqual(knownRemoteSignerIntents(source), [...REVIEWED_REMOTE_SIGNER_INTENTS]);
  const edit = (replacement: string) => source.replace(/(const KNOWN_INTENTS\b[^[]*\[\s*)("block-proposal", )/, replacement);
  const differs = (changed: string) => {
    assert.notEqual(changed, source);
    let intents: string[] | undefined;
    try { intents = knownRemoteSignerIntents(changed); } catch { return true; }
    return JSON.stringify(intents) !== JSON.stringify(REVIEWED_REMOTE_SIGNER_INTENTS);
  };
  // Any change fails the guard, whatever the name, and a comment cannot satisfy it.
  assert.ok(differs(edit(`$1"transfer", $2`)));
  assert.ok(differs(edit(`$1"wallet-tx", $2`)));
  assert.ok(differs(`${edit(`$1"wallet-tx", $2`)}\n// renderIntent( wired later\n`));
  assert.ok(differs(edit("$1")));
  assert.ok(differs(edit(`$1...EXTRA, $2`)));
  assert.ok(differs(`${source}\nconst KNOWN_INTENTS_2 = KNOWN_INTENTS;\n`));
});
