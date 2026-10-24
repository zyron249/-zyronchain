import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildFixtureChain, FEE, startEndpoint, unreachableUrl } from "./fixture.mjs";
import { PINNED_GENESIS_HASH, reconcile, verifySupply } from "../src/verify.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");
const MAX = 50_000_000n * 100_000_000n;

const fixture = buildFixtureChain();

async function withEndpoints(specs, run) {
  const endpoints = [];
  try {
    for (const spec of specs) endpoints.push(await startEndpoint(spec.fixture ?? fixture, spec));
    return await run(endpoints.map((e) => e.url));
  } finally {
    await Promise.all(endpoints.map((e) => e.close()));
  }
}

const opts = (endpoints, extra = {}) => ({ endpoints, genesis: fixture.genesis, expectedGenesisHash: fixture.genesisHash, batchSize: 2, ...extra });

test("pinned genesis hash matches the repo docs and the web verifier", () => {
  assert.match(PINNED_GENESIS_HASH, /^[0-9a-f]{64}$/);
  assert.ok(readFileSync(join(repo, "docs", "OPEN_TESTNET.md"), "utf8").includes(`equals \`${PINNED_GENESIS_HASH}\``));
  assert.ok(readFileSync(join(repo, "website", "verify", "session.js"), "utf8").includes(`REPOSITORY_GENESIS_PIN = "${PINNED_GENESIS_HASH}"`));
});

test("happy path: replay from genesis reconciles to exactly 50,000,000 ZYN", async () => {
  await withEndpoints([{}, {}], async (endpoints) => {
    const report = await verifySupply(opts(endpoints));
    assert.equal(report.ok, true);
    assert.equal(report.height, 5);
    assert.equal(report.tipHash, fixture.blocks.at(-1).hash);
    assert.equal(report.genesisHash, fixture.genesisHash);
    assert.equal(BigInt(report.genesisSupplyAtoms), MAX);
    // 9 transfers at the fixed fee; the odd/half share burns.
    const burned = 9n * BigInt(FEE - Math.floor(FEE / 2));
    assert.equal(BigInt(report.buckets.burnedAtoms), burned);
    assert.equal(BigInt(report.buckets.balancesAtoms) + burned, MAX);
    assert.equal(BigInt(report.buckets.lockedAtoms) + BigInt(report.buckets.spendableAtoms), BigInt(report.buckets.balancesAtoms));
    assert.equal(BigInt(report.buckets.pendingAtoms), 0n);
    assert.equal(BigInt(report.totalAtoms), MAX);
    assert.equal(report.endpointsChecked, 2);
  });
});

test("mismatched header hash between endpoints fails closed", async () => {
  // Same genesis, but block 3 differs on the second endpoint.
  const mutateBlocks = (blocks) => blocks.map((b) => (b.header.height === 3 ? { ...b, hash: "f".repeat(64) } : b));
  await withEndpoints([{}, { mutateBlocks }], async (endpoints) => {
    await assert.rejects(verifySupply(opts(endpoints)), /header hash mismatch at height 3/);
  });
});

test("wrong genesis hash fails closed", async () => {
  await withEndpoints([{}, {}], async (endpoints) => {
    await assert.rejects(verifySupply(opts(endpoints, { expectedGenesisHash: "a".repeat(64) })), /genesis hash mismatch/);
  });
  await withEndpoints([{}, { genesisHashOverride: "b".repeat(64) }], async (endpoints) => {
    await assert.rejects(verifySupply(opts(endpoints)), /reports genesis hash/);
  });
});

test("fewer than two endpoints fails closed", async () => {
  await withEndpoints([{}], async (endpoints) => {
    await assert.rejects(verifySupply(opts(endpoints)), /at least 2 distinct endpoints/);
    await assert.rejects(verifySupply(opts([endpoints[0], endpoints[0]])), /at least 2 distinct endpoints/);
  });
});

test("unreachable endpoint fails closed", async () => {
  const dead = await unreachableUrl();
  await withEndpoints([{}], async ([live]) => {
    await assert.rejects(verifySupply(opts([live, dead])), /unreachable|failed/);
  });
  await withEndpoints([{}, { failAll: true }], async (endpoints) => {
    await assert.rejects(verifySupply(opts(endpoints)), /HTTP 500/);
  });
});

test("missing blocks fail closed", async () => {
  const mutateBlocks = (blocks) => blocks.filter((b) => b.header.height !== 4);
  await withEndpoints([{ mutateBlocks }, { mutateBlocks }], async (endpoints) => {
    await assert.rejects(verifySupply(opts(endpoints)), /missing|expected block/);
  });
});

test("tampered block served by every endpoint fails replay validation", async () => {
  const mutateBlocks = (blocks) => blocks.map((b) => {
    if (b.header.height !== 2) return b;
    b.transactions[0].amountAtoms += 1;
    return b;
  });
  await withEndpoints([{ mutateBlocks }, { mutateBlocks }], async (endpoints) => {
    await assert.rejects(verifySupply(opts(endpoints)), /replay rejected block 2/);
  });
});

test("genesis supply other than 50M fails even on a valid chain", async () => {
  const small = buildFixtureChain({ founderZyn: 4_000_000, blocks: 2, profile: false });
  await withEndpoints([{ fixture: small }, { fixture: small }], async (endpoints) => {
    await assert.rejects(
      verifySupply({ endpoints, genesis: small.genesis, expectedGenesisHash: small.genesisHash }),
      /genesis supply .* is not exactly 50000000 ZYN/
    );
  });
});

test("reconcile rejects tampered balances or burn totals", () => {
  const good = { genesisSupplyAtoms: MAX, burnedAtoms: 50_000n, balances: [MAX - 50_000n], lockedAtoms: 0n, pendingAtoms: 0n };
  assert.equal(reconcile(good).totalAtoms, MAX);
  assert.throws(() => reconcile({ ...good, balances: [MAX - 49_999n] }), /supply does not reconcile/);
  assert.throws(() => reconcile({ ...good, burnedAtoms: 50_001n }), /supply does not reconcile/);
  assert.throws(() => reconcile({ ...good, balances: [MAX - 50_000n, -1n] }), /negative/);
  assert.throws(() => reconcile({ ...good, lockedAtoms: MAX }), /locked/);
  assert.throws(() => reconcile({ ...good, pendingAtoms: 1n }), /supply does not reconcile/);
});

test("CLI exits non-zero with a clear reason and zero on success", async () => {
  const cli = join(here, "..", "cli.mjs");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "sv-"));
  const genesisFile = join(dir, "genesis.json");
  writeFileSync(genesisFile, JSON.stringify(fixture.genesis));
  await withEndpoints([{}, {}], async (endpoints) => {
    const run = (args) => new Promise((resolve) => {
      import("node:child_process").then(({ spawn }) => {
        const child = spawn(process.execPath, [cli, ...args]);
        let out = ""; let err = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("close", (code) => resolve({ code, out, err }));
      });
    });
    const ok = await run(["--genesis", genesisFile, "--expected-genesis-hash", fixture.genesisHash, "--endpoint", endpoints[0], "--endpoint", endpoints[1], "--json"]);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(JSON.parse(ok.out).totalAtoms, MAX.toString());
    const one = await run(["--genesis", genesisFile, "--expected-genesis-hash", fixture.genesisHash, "--endpoint", endpoints[0]]);
    assert.equal(one.code, 1);
    assert.match(one.err, /FAIL: .*at least 2 distinct endpoints/);
  });
  assert.equal(spawnSync(process.execPath, [cli, "--help"]).status, 0);
});
