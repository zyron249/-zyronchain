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

type Status = { name: string; publicKey?: string; up: boolean; activeSet?: { height: number; validators: Array<{ publicKey: string }> } };
type Evaluation = { ok: boolean; quorum: number; activeValidatorCount: number; activeValidatorsUp: number; activeSetHeight: number | null; activeSetSource: string };
// @ts-ignore -- plain ESM script without type declarations
const quorumModule = (await import("../../scripts/gateway-quorum.mjs")) as {
  quorumThreshold(n: number): number;
  evaluateQuorum(statuses: Status[], fallback: Array<{ publicKey: string }>): Evaluation;
};
const { quorumThreshold, evaluateQuorum } = quorumModule;

const T0 = 1_700_000_000_000;
const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const validator = (n: number): Validator => ({ address: addr(n), publicKey: pub(n) });
const set = (ids: number[], height = 10) => ({ height, validators: ids.map(validator) });
const hosted = (ids: number[], up: number[], activeSet?: ReturnType<typeof set>): Status[] =>
  ids.map((id) => ({ name: `v${id}`, publicKey: pub(id), up: up.includes(id), ...(activeSet && up.includes(id) ? { activeSet } : {}) }));

test("quorumThreshold is floor(2n/3)+1", () => {
  const expected: Array<[number, number]> = [[1, 1], [2, 2], [3, 3], [4, 3], [5, 4], [6, 5], [7, 5], [10, 7], [100, 67]];
  for (const [n, q] of expected) assert.equal(quorumThreshold(n), q, `n=${n}`);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => quorumThreshold(bad), /invalid validator set size/);
});

test("n=4 active set: 3 up is a quorum, 2 up is not", () => {
  const ids = [1, 2, 3, 4];
  const ok = evaluateQuorum(hosted(ids, [1, 2, 3], set(ids)), ids.map(validator));
  assert.deepEqual([ok.ok, ok.quorum, ok.activeValidatorCount, ok.activeValidatorsUp, ok.activeSetSource], [true, 3, 4, 3, "validators"]);
  const lost = evaluateQuorum(hosted(ids, [1, 2], set(ids)), ids.map(validator));
  assert.deepEqual([lost.ok, lost.quorum], [false, 3]);
});

test("n=5 active set needs 4 and n=7 needs 5", () => {
  const five = [1, 2, 3, 4, 5];
  assert.deepEqual([evaluateQuorum(hosted(five, [1, 2, 3, 4], set(five)), []).ok, evaluateQuorum(hosted(five, [1, 2, 3, 4], set(five)), []).quorum], [true, 4]);
  assert.equal(evaluateQuorum(hosted(five, [1, 2, 3], set(five)), []).ok, false);
  const seven = [1, 2, 3, 4, 5, 6, 7];
  const r = evaluateQuorum(hosted(seven, [1, 2, 3, 4, 5], set(seven)), []);
  assert.deepEqual([r.ok, r.quorum, r.activeValidatorCount], [true, 5, 7]);
  assert.equal(evaluateQuorum(hosted(seven, [1, 2, 3, 4], set(seven)), []).ok, false);
});

test("the active set, not the genesis set, decides after a validator_update", () => {
  const genesisSet = [1, 2, 3, 4].map(validator);
  // Grown to 5 (one external member not hosted here): 3 hosted up no longer suffices.
  const grown = set([1, 2, 3, 4, 5], 150);
  const g = evaluateQuorum(hosted([1, 2, 3, 4], [1, 2, 3], grown), genesisSet);
  assert.deepEqual([g.ok, g.quorum, g.activeValidatorCount, g.activeSetHeight], [false, 4, 5, 150]);
  assert.equal(evaluateQuorum(hosted([1, 2, 3, 4], [1, 2, 3, 4], grown), genesisSet).ok, true);
  // Shrunk to 3 with v4 removed: an up v4 does not count; v1..v3 up is the quorum (3 of 3).
  const shrunk = set([1, 2, 3], 150);
  const s = evaluateQuorum(hosted([1, 2, 3, 4], [1, 2, 4], shrunk), genesisSet);
  assert.deepEqual([s.ok, s.quorum, s.activeValidatorsUp], [false, 3, 2]);
  assert.equal(evaluateQuorum(hosted([1, 2, 3, 4], [1, 2, 3], shrunk), genesisSet).ok, true);
});

test("the most advanced report wins; with no report the genesis set is the fallback", () => {
  const ids = [1, 2, 3, 4];
  const statuses: Status[] = [
    { name: "v1", publicKey: pub(1), up: true, activeSet: set(ids, 149) },
    { name: "v2", publicKey: pub(2), up: true, activeSet: set([1, 2, 3, 4, 5], 150) },
    { name: "v3", publicKey: pub(3), up: true },
    { name: "v4", publicKey: pub(4), up: false, activeSet: set([1], 999) } // down nodes are ignored
  ];
  const r = evaluateQuorum(statuses, ids.map(validator));
  assert.deepEqual([r.activeSetHeight, r.activeValidatorCount, r.quorum, r.ok], [150, 5, 4, false]);
  const fallback = evaluateQuorum(hosted(ids, [1, 2, 3]), ids.map(validator));
  assert.deepEqual([fallback.activeSetSource, fallback.quorum, fallback.ok], ["genesis", 3, true]);
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
      [0x21, 0x22, 0x23, 0x24].map((id) => ({ name: `v${id}`, publicKey: pub(id), up: id !== 0x24, activeSet: after })),
      devGenesis().validators
    );
    assert.deepEqual([r.quorum, r.activeValidatorCount, r.ok], [4, 5, false]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
