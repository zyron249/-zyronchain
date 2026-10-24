// Open TESTNET gateway quorum: /health, /healthz and /readyz compute the quorum
// as floor(2n/3)+1 of the ACTIVE validator set (the set governing the next
// height, as each validator reports on GET /validator-set), not of the genesis
// set, so the gateway follows validator_update activations.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { expectedValidator } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { createRpcServer, NodeService } from "../src/node-base.js";
import { ChainStore } from "../src/storage.js";
import { createValidatorApproval, createValidatorSetUpdate } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type GenesisConfig, type Validator } from "../src/types.js";

type Status = { name: string; publicKey?: string; up: boolean; height?: number; activeSet?: unknown };
type Evaluation = { ok: boolean; quorum: number; activeValidatorCount: number; activeValidatorsUp: number; activeSetHeight: number | null; activeSetSource: string; activeSetFallback: boolean; activeSetSeed?: string; activeSetRejected?: { reason: string; size: number; min: number; height: number } };
type Options = { addressOf?: (publicKey: string) => string; maxValidators?: number; minValidators?: number; initial?: { source?: string; height: number; validators: Validator[] } };
// @ts-ignore -- plain ESM script without type declarations
const quorumModule = (await import("../../scripts/gateway-quorum.mjs")) as {
  MAX_REPORTED_VALIDATORS: number;
  quorumThreshold(n: number): number;
  validateReportedSet(set: unknown, tipHeight: number | undefined, options?: Options): { height: number; validators: Validator[] } | undefined;
  evaluateQuorum(statuses: Status[], genesis: Validator[], options?: Options): Evaluation;
  createActiveSetTracker(genesis: Validator[], options?: Options): { evaluate(statuses: Status[]): Evaluation; trusted: { source: string; height: number; validators: Validator[] }; seededFrom: string };
  activeSetSeedFromHistory(history: unknown): { source: string; height: number; validators: Validator[] } | undefined;
};
const { activeSetSeedFromHistory, MAX_REPORTED_VALIDATORS, quorumThreshold, validateReportedSet, evaluateQuorum, createActiveSetTracker } = quorumModule;
const options: Options = { addressOf: addressFromPublicKey };

const T0 = 1_700_000_000_000;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const validator = (n: number): Validator => ({ address: addr(n), publicKey: pub(n) });
const set = (ids: number[], height = 10) => ({ height, validators: ids.map(validator) });
const TIP = 200;
// Hosted validators `ids`; those in `up` are up at TIP and report `activeSet`.
const hosted = (ids: number[], up: number[], activeSet?: unknown): Status[] =>
  ids.map((id) => ({ name: `v${id}`, publicKey: pub(id), up: up.includes(id), ...(up.includes(id) ? { height: TIP } : {}), ...(activeSet && up.includes(id) ? { activeSet } : {}) }));

test("quorumThreshold is floor(2n/3)+1", () => {
  const expected: Array<[number, number]> = [[1, 1], [2, 2], [3, 3], [4, 3], [5, 4], [6, 5], [7, 5], [10, 7], [100, 67]];
  for (const [n, q] of expected) assert.equal(quorumThreshold(n), q, `n=${n}`);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => quorumThreshold(bad), /invalid validator set size/);
});

test("n=4 active set: 3 up is a quorum, 2 up is not", () => {
  const ids = [1, 2, 3, 4];
  const ok = evaluateQuorum(hosted(ids, [1, 2, 3], set(ids)), ids.map(validator), options);
  assert.deepEqual([ok.ok, ok.quorum, ok.activeValidatorCount, ok.activeValidatorsUp], [true, 3, 4, 3]);
  const lost = evaluateQuorum(hosted(ids, [1, 2], set(ids)), ids.map(validator), options);
  assert.deepEqual([lost.ok, lost.quorum], [false, 3]);
});

test("n=5 active set needs 4 and n=7 needs 5", () => {
  const five = [1, 2, 3, 4, 5];
  const r5 = evaluateQuorum(hosted(five, [1, 2, 3, 4], set(five)), five.map(validator), options);
  assert.deepEqual([r5.ok, r5.quorum], [true, 4]);
  assert.equal(evaluateQuorum(hosted(five, [1, 2, 3], set(five)), five.map(validator), options).ok, false);
  const seven = [1, 2, 3, 4, 5, 6, 7];
  const r = evaluateQuorum(hosted(seven, [1, 2, 3, 4, 5], set(seven)), seven.map(validator), options);
  assert.deepEqual([r.ok, r.quorum, r.activeValidatorCount], [true, 5, 7]);
  assert.equal(evaluateQuorum(hosted(seven, [1, 2, 3, 4], set(seven)), seven.map(validator), options).ok, false);
});

test("a set agreed by a quorum of the trusted set replaces the genesis set after a validator_update", () => {
  const genesisSet = [1, 2, 3, 4].map(validator);
  // Grown to 5 (one external member not hosted here): 3 hosted up no longer suffices.
  const grown = set([1, 2, 3, 4, 5], 150);
  const g = evaluateQuorum(hosted([1, 2, 3, 4], [1, 2, 3], grown), genesisSet, options);
  assert.deepEqual([g.ok, g.quorum, g.activeValidatorCount, g.activeSetHeight, g.activeSetSource, g.activeSetFallback], [false, 4, 5, 150, "validators", false]);
  assert.equal(evaluateQuorum(hosted([1, 2, 3, 4], [1, 2, 3, 4], grown), genesisSet, options).ok, true);
  // Shrunk to 3 with v4 removed: an up v4 does not count once v1..v3 agree.
  const tracker = createActiveSetTracker(genesisSet, options);
  assert.equal(tracker.evaluate(hosted([1, 2, 3, 4], [1, 2, 3], set([1, 2, 3], 150))).ok, true);
  const s = tracker.evaluate(hosted([1, 2, 3, 4], [1, 2, 4], set([1, 2, 3], 150)));
  assert.deepEqual([s.ok, s.quorum, s.activeValidatorsUp, s.activeSetSource], [false, 3, 2, "validators"]);
});

test("the tracker keeps the agreed set and only moves on a new quorum agreement", () => {
  const tracker = createActiveSetTracker([1, 2, 3, 4].map(validator), options);
  tracker.evaluate(hosted([1, 2, 3, 4], [1, 2, 3, 4], set([1, 2, 3, 4, 5], 150)));
  // Later only v1 is up and claims a different set: ignored, the agreed 5-set stays.
  const r = tracker.evaluate(hosted([1, 2, 3, 4], [1], set([1], 190)));
  assert.deepEqual([r.activeValidatorCount, r.activeSetHeight, r.activeSetFallback, r.ok], [5, 150, true, false]);
  // An older agreed set cannot roll the tracker back.
  const old = tracker.evaluate(hosted([1, 2, 3, 4], [1, 2, 3, 4], set([1, 2, 3, 4], 100)));
  assert.deepEqual([old.activeValidatorCount, old.activeSetHeight], [5, 150]);
});

test("PoC: one node shrinking the set to itself with a huge height cannot make quorum 1", () => {
  const ids = [1, 2, 3, 4];
  for (const height of [9e15, TIP + 1]) {
    const liar = { height, validators: [validator(1)] };
    const r = evaluateQuorum(hosted(ids, [1], liar), ids.map(validator), options);
    assert.deepEqual([r.ok, r.quorum, r.activeValidatorCount, r.activeSetSource, r.activeSetFallback], [false, 3, 4, "genesis", true], `height=${height}`);
  }
  // Even with honest peers up, the liar's report does not win over the agreed set.
  const statuses = hosted(ids, [1, 2, 3, 4], set(ids, 50));
  statuses[0]!.activeSet = { height: 9e15, validators: [validator(1)] };
  const r = evaluateQuorum(statuses, ids.map(validator), options);
  assert.deepEqual([r.ok, r.quorum, r.activeValidatorCount, r.activeSetHeight], [true, 3, 4, 50]);
});

test("PoC: one node inflating the set with 1000 fake keys cannot cause a 503", () => {
  const ids = [1, 2, 3, 4];
  const fakes = Array.from({ length: 1000 }, (_, i) => validator(1000 + i));
  const statuses = hosted(ids, [1, 2, 3, 4], set(ids, 50));
  for (const height of [9e15, TIP + 1]) {
    statuses[0]!.activeSet = { height, validators: fakes };
    const r = evaluateQuorum(statuses, ids.map(validator), options);
    assert.deepEqual([r.ok, r.quorum, r.activeValidatorCount, r.activeSetHeight], [true, 3, 4, 50], `height=${height}`);
  }
  // A within-cap inflated set reported by one node alone is not adopted either.
  statuses[0]!.activeSet = { height: TIP + 1, validators: Array.from({ length: 100 }, (_, i) => validator(1000 + i)) };
  assert.equal(evaluateQuorum(statuses, ids.map(validator), options).activeValidatorCount, 4);
});

test("reported sets are checked for height, size, format and duplicates", () => {
  const ok = set([1, 2, 3, 4], 10);
  assert.ok(validateReportedSet(ok, 9, options));
  assert.equal(validateReportedSet(ok, 8, options), undefined, "height above tip+1");
  assert.equal(validateReportedSet(ok, undefined, options), undefined, "no tip");
  assert.equal(validateReportedSet({ height: 0, validators: ok.validators }, 9, options), undefined);
  assert.equal(validateReportedSet({ height: 1.5, validators: ok.validators }, 9, options), undefined);
  assert.equal(validateReportedSet({ height: 5, validators: [] }, 9, options), undefined, "empty");
  const big = Array.from({ length: MAX_REPORTED_VALIDATORS + 1 }, (_, i) => validator(100 + i));
  assert.equal(validateReportedSet({ height: 5, validators: big }, 9, options), undefined, "too large");
  assert.ok(validateReportedSet({ height: 5, validators: big.slice(1) }, 9, options));
  assert.equal(validateReportedSet({ height: 5, validators: [validator(1), validator(1)] }, 9, options), undefined, "duplicate key");
  assert.equal(validateReportedSet({ height: 5, validators: [{ publicKey: "A" }] }, 9, options), undefined, "bad key");
  assert.equal(validateReportedSet({ height: 5, validators: [{ publicKey: pub(1).toUpperCase() }] }, 9, options), undefined, "bad key case");
  assert.equal(validateReportedSet({ height: 5, validators: [{ address: "nope", publicKey: pub(1) }] }, 9, options), undefined, "bad address");
  assert.equal(validateReportedSet({ height: 5, validators: [{ address: addr(2), publicKey: pub(1) }] }, 9, options), undefined, "address mismatch");
  assert.equal(validateReportedSet({ height: 5, validators: [{ address: addr(1), publicKey: pub(1) }, { address: addr(1), publicKey: pub(2) }] }, 9), undefined, "duplicate address");
  for (const bad of [null, "x", 5, { height: 5 }, { height: 5, validators: "x" }]) assert.equal(validateReportedSet(bad, 9, options), undefined);
});

test("with no valid report the genesis set is used and the fallback is surfaced", () => {
  const ids = [1, 2, 3, 4];
  const r = evaluateQuorum(hosted(ids, [1, 2, 3]), ids.map(validator), options);
  assert.deepEqual([r.activeSetSource, r.activeSetFallback, r.activeSetHeight, r.quorum, r.ok], ["genesis", true, null, 3, true]);
  // Reports from non-members of the trusted set are ignored.
  const outsiders: Status[] = [5, 6, 7].map((id) => ({ name: `x${id}`, publicKey: pub(id), up: true, height: TIP, activeSet: set([5, 6, 7], 50) }));
  const o = evaluateQuorum([...hosted(ids, []), ...outsiders], ids.map(validator), options);
  assert.deepEqual([o.activeSetSource, o.activeValidatorCount, o.ok], ["genesis", 4, false]);
});

function devGenesis(): GenesisConfig {
  const pool = addr(0x90);
  return {
    chainId: "zyron-gateway-quorum-1",
    timestampMs: T0,
    validators: [0x21, 0x22, 0x23, 0x24].map(validator),
    activityOracles: [pub(0x91)],
    activityPool: pool,
    allocations: [{ address: pool, amountAtoms: 1_000 * ATOMS_PER_ZYN }]
  };
}

const ID_BY_ADDRESS = new Map([0x21, 0x22, 0x23, 0x24, 0x25].map((id) => [addr(id), id]));
function produce(chain: ZyronChain, transactions: Parameters<ZyronChain["produceBlock"]>[0], signers: number[]): void {
  const at = chain.tip.header.timestampMs + 1_000;
  const proposer = ID_BY_ADDRESS.get(expectedValidator(chain.validatorsAt(chain.height + 1), chain.height + 1, 0).address)!;
  let block = chain.produceBlock(transactions, key(proposer), { timestampMs: at });
  for (const id of signers) block = chain.attestBlock(block, key(id));
  chain.acceptBlock(block, at);
}

test("node GET /validator-set reports the set governing the next height, across a validator_update", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-gateway-quorum-"));
  const store = await ChainStore.open(devGenesis(), directory);
  const server = createRpcServer(new NodeService(store));
  try {
    await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => done()); });
    const port = (server.address() as AddressInfo).port;
    const fetchSet = async () => (await (await fetch(`http://127.0.0.1:${port}/validator-set`)).json()) as { height: number; validators: Validator[] };

    const before = await fetchSet();
    assert.equal(before.height, 1);
    assert.deepEqual(before.validators, [0x21, 0x22, 0x23, 0x24].map(validator));
    assert.deepEqual(await fetchSet(), before, "cached per height");
    assert.equal(quorumThreshold(before.validators.length), 3);

    const chain = store.chain;
    const activationHeight = 1 + 1 + 100;
    const input = { chainId: chain.genesis.chainId, nonce: 1, sender: addr(0x21), activationHeight, validators: [0x21, 0x22, 0x23, 0x24, 0x25].map(validator) };
    const approvals = [0x21, 0x22, 0x23].map((id) => createValidatorApproval(input, key(id), pub(id)));
    const tx = createValidatorSetUpdate({ ...input, approvals, timestampMs: T0 + 10 }, key(0x21), pub(0x21));
    produce(chain, [tx], [0x21, 0x22, 0x23]);
    while (chain.height + 1 < activationHeight) produce(chain, [], [0x21, 0x22, 0x23]);

    const after = await fetchSet();
    assert.equal(after.height, activationHeight);
    assert.deepEqual(after.validators, [0x21, 0x22, 0x23, 0x24, 0x25].map(validator));
    const r = evaluateQuorum(
      [0x21, 0x22, 0x23, 0x24].map((id) => ({ name: `v${id}`, publicKey: pub(id), up: id !== 0x24, height: chain.height, activeSet: after })),
      devGenesis().validators,
      options
    );
    assert.deepEqual([r.quorum, r.activeValidatorCount, r.ok], [4, 5, false]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart seeding: a verified history past a validator_update seeds the tracker (read-only)", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zyron-gateway-seed-"));
  try {
    const store = await ChainStore.open(devGenesis(), directory);
    const chain = store.chain;
    const activationHeight = 1 + 1 + 100;
    const input = { chainId: chain.genesis.chainId, nonce: 1, sender: addr(0x21), activationHeight, validators: [0x21, 0x22, 0x23, 0x24, 0x25].map(validator) };
    const approvals = [0x21, 0x22, 0x23].map((id) => createValidatorApproval(input, key(id), pub(id)));
    const tx = createValidatorSetUpdate({ ...input, approvals, timestampMs: T0 + 10 }, key(0x21), pub(0x21));
    produce(chain, [tx], [0x21, 0x22, 0x23]);
    while (chain.height + 1 < activationHeight) produce(chain, [], [0x21, 0x22, 0x23]);
    const heightBefore = chain.height;
    const seed = activeSetSeedFromHistory({ chain });
    assert.ok(seed);
    assert.equal(chain.height, heightBefore, "seeding does not change the chain");
    assert.deepEqual([seed.source, seed.height, seed.validators.length], ["snapshot", heightBefore + 1, 5]);
    const genesisSet = devGenesis().validators;
    const tracker = createActiveSetTracker(genesisSet, { ...options, initial: seed });
    assert.equal(tracker.seededFrom, "snapshot");
    const r = tracker.evaluate([0x21, 0x22, 0x23, 0x24].map((id) => ({ name: `v${id}`, publicKey: pub(id), up: true, height: chain.height })));
    assert.deepEqual([r.activeSetSource, r.activeSetSeed, r.activeValidatorCount, r.quorum], ["snapshot", "snapshot", 5, 4]);

    // Without verified history: genesis, quorum 3.
    const g = createActiveSetTracker(genesisSet, options);
    assert.equal(g.seededFrom, "genesis");
    const gr = g.evaluate([0x21, 0x22, 0x23, 0x24].map((id) => ({ name: `v${id}`, publicKey: pub(id), up: true, height: chain.height })));
    assert.deepEqual([gr.activeSetSource, gr.activeSetSeed, gr.activeValidatorCount, gr.quorum], ["genesis", "genesis", 4, 3]);
    for (const history of [undefined, null, {}, { chain: { height: 0, validatorsAt: () => genesisSet } }, { chain: { height: undefined, validatorsAt: () => genesisSet } }]) {
      assert.equal(activeSetSeedFromHistory(history), undefined);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("floor: a quorum-agreed set below minValidators is rejected and the trusted set is kept", () => {
  const five = [1, 2, 3, 4, 5];
  const opts: Options = { ...options, minValidators: 4, initial: { source: "snapshot", height: 10, validators: five.map(validator) } };
  for (const shrunk of [[1], [1, 2, 3]]) {
    const tracker = createActiveSetTracker([1, 2, 3, 4].map(validator), opts);
    const r = tracker.evaluate(hosted(five, five, set(shrunk, 150)));
    assert.deepEqual([r.activeSetSource, r.activeValidatorCount, r.quorum, r.ok], ["snapshot", 5, 4, true], `size=${shrunk.length}`);
    assert.deepEqual(r.activeSetRejected, { reason: "below_min_validators", size: shrunk.length, min: 4, height: 150 });
    assert.equal(tracker.trusted.validators.length, 5);
  }
  const tracker = createActiveSetTracker([1, 2, 3, 4].map(validator), opts);
  const r = tracker.evaluate(hosted(five, five, set([1, 2, 3, 4], 150)));
  assert.deepEqual([r.activeSetSource, r.activeValidatorCount, r.quorum, r.activeSetHeight, r.ok], ["validators", 4, 3, 150, true]);
  assert.equal(r.activeSetRejected, undefined);
  assert.throws(() => createActiveSetTracker([1, 2, 3, 4].map(validator), { minValidators: 0 }), /invalid minValidators/);
});
