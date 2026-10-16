// P0-07: founder vesting and the permanent-liquidity lock must hold on every
// path that builds chain state without live block-by-block validation by this
// node: trusted snapshot install, portable State-v2 install, P2P checkpoint
// transfer, P2P state sync, recovery-checkpoint reopen (pruned history),
// State-v2 store rebuild on reopen, full finalized-log replay and P2P block
// sync from a peer that runs a lock-free twin genesis.
//
// The attack artifacts are real: a "twin" genesis that is identical except
// for `allocationLocks` has the same chain ID and genesis hash (legacy genesis
// identity does not commit to configuration fields, NEW-1 / #961), so blocks
// it finalizes carry valid proposer signatures, state roots and finality
// certificates. Every such block that spends locked funds must still be
// refused by a node configured with the locked genesis, whichever path built
// that node's state. See docs/ALLOCATION_LOCKS.md.
import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ZyronChain } from "../src/chain.js";
import { canonicalJson, sha256Hex } from "../src/codec.js";
import { isConsensusV6, signV6, V6_COMMIT_VOTE_DOMAIN, votePayload } from "../src/consensus-v6.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";
import { NodeService } from "../src/node.js";
import { createP2PNode } from "../src/p2p.js";
import { fetchTrustedSnapshotFromPeer, registerP2PCheckpointProtocol } from "../src/p2p-checkpoint.js";
import { fetchTrustedPortableStateFromPeer, registerP2PStateProtocol } from "../src/p2p-state.js";
import { registerP2PSyncProtocol, syncP2PFrom } from "../src/p2p-sync.js";
import { loadOrCreateNodeIdentity } from "../src/peer-identity.js";
import { createStateV2PortableBundle } from "../src/state-v2-portable.js";
import { ChainStore } from "../src/storage.js";
import { createProtocolUpgrade, createProtocolUpgradeApproval, createTransfer } from "../src/transaction.js";
import { ATOMS_PER_ZYN, type Block, type GenesisConfig, type Transaction } from "../src/types.js";

const ZYN = ATOMS_PER_ZYN;
const DAY_MS = 86_400_000;
const CLIFF_MS = 365 * DAY_MS;
const LINEAR_MS = 1_095 * DAY_MS;
const FOUNDER_ATOMS = 5_000_000 * ZYN;
const LIQUIDITY_ATOMS = 20_000_000 * ZYN;
const VESTING = /Founder allocation is still vesting/;
const LIQUIDITY_LOCKED = /Permanent-liquidity reserve is locked/;
const FUTURE = /Block time too far in future/;
const GENESIS_MS = 1_700_000_000_000;

const key = (n: number) => n.toString(16).padStart(64, "0");
const pub = (n: number) => publicKeyFromPrivate(key(n));
const addr = (n: number) => addressFromPublicKey(pub(n));
const VALIDATOR = 0x61, ORACLE = 0x62, FOUNDER = 0x63, PUBLIC_DISTRIBUTION = 0x64, LIQUIDITY = 0x65, ECOSYSTEM = 0x66, ALICE = 0x67;

function lockedGenesis(version: number): GenesisConfig {
  return {
    chainId: `zyron-lock-bypass-v${version}`,
    timestampMs: GENESIS_MS,
    validators: [{ address: addr(VALIDATOR), publicKey: pub(VALIDATOR) }],
    activityOracles: [pub(ORACLE)],
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: FOUNDER_ATOMS },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: LIQUIDITY_ATOMS },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) }
  };
}

function twinGenesis(locked: GenesisConfig): GenesisConfig {
  const { allocationLocks: _dropped, ...twin } = structuredClone(locked);
  return twin;
}

function vestedAt(elapsedMs: number): number {
  if (elapsedMs <= CLIFF_MS) return 0;
  const linear = BigInt(Math.min(elapsedMs - CLIFF_MS, LINEAR_MS));
  return Number((BigInt(FOUNDER_ATOMS) * linear) / BigInt(LINEAR_MS));
}

/** Adds the finality certificate a single honest-looking validator would sign. */
function certify(chain: ZyronChain, block: Block): Block {
  if (isConsensusV6(block.header.version)) {
    block.commitRound = 0;
    block.attestations = [{
      validator: addr(VALIDATOR),
      publicKey: pub(VALIDATOR),
      signature: signV6(V6_COMMIT_VOTE_DOMAIN, votePayload(block.header.chainId, block.header.height, 0, block.hash), key(VALIDATOR))
    }];
    return block;
  }
  return chain.attestBlock(block, key(VALIDATOR));
}

const txVersionFor = (protocolVersion: number): 1 | 2 => (protocolVersion >= 3 ? 2 : 1);

function transfer(genesis: GenesisConfig, sender: number, amountAtoms: number, protocolVersion: number): Transaction {
  return createTransfer({
    chainId: genesis.chainId, nonce: 1, sender: addr(sender), receiver: addr(ALICE),
    amountAtoms, feeAtoms: 10, timestampMs: genesis.timestampMs + 1
  }, key(sender), pub(sender), txVersionFor(protocolVersion));
}

interface Fixture {
  version: number;
  locked: GenesisConfig;
  twin: GenesisConfig;
  /** Honest finalized blocks 1..H (identical on both genesis files). */
  blocks: Block[];
  height: number;
  /** Timestamp of the next block: well before the founder cliff. */
  nextMs: number;
  founderTx: Transaction;
  liquidityTx: Transaction;
  /** Twin-finalized block H+1 spending 1 ZYN of the founder allocation before the cliff. */
  founderBlock: Block;
  /** Twin-finalized block H+1 spending 1 ZYN of the permanent-liquidity reserve. */
  liquidityBlock: Block;
  /** Twin-finalized block H+1 stamped one day after the cliff (clock-skew unlock attempt). */
  futureBlock: Block;
  /** Twin-finalized block H+1 half-way through linear vesting that overspends the vested amount by 1 atom. */
  overspendBlock: Block;
}

const fixtures = new Map<number, Fixture>();

function fixture(version: number): Fixture {
  const cached = fixtures.get(version);
  if (cached) return cached;
  const locked = lockedGenesis(version);
  const twin = twinGenesis(locked);
  const lockedChain = new ZyronChain(locked);
  const twinChain = new ZyronChain(twin);
  // The attack premise: identical chain identity.
  assert.equal(twinChain.tip.hash, lockedChain.tip.hash);
  const blocks: Block[] = [];
  const target = 101;
  let upgrade: Transaction | undefined;
  if (version > 1) {
    const input = { chainId: locked.chainId, nonce: 1, sender: addr(VALIDATOR), activationHeight: 101, protocolVersion: version };
    upgrade = createProtocolUpgrade({
      ...input,
      approvals: [createProtocolUpgradeApproval(input, key(VALIDATOR), pub(VALIDATOR))],
      timestampMs: locked.timestampMs + 10
    }, key(VALIDATOR), pub(VALIDATOR));
  }
  for (let height = 1; height <= target; height += 1) {
    const timestampMs = locked.timestampMs + height * 1_000;
    const block = certify(lockedChain, lockedChain.produceBlock(height === 1 && upgrade ? [upgrade] : [], key(VALIDATOR), { timestampMs }));
    lockedChain.acceptBlock(block, timestampMs);
    twinChain.acceptBlock(structuredClone(block), timestampMs);
    blocks.push(block);
  }
  assert.equal(lockedChain.protocolVersionAt(target + 1), version);
  const nextMs = locked.timestampMs + (target + 1) * 1_000;
  const founderTx = transfer(locked, FOUNDER, ZYN, version);
  const liquidityTx = transfer(locked, LIQUIDITY, ZYN, version);
  const twinBlock = (txs: Transaction[], timestampMs: number) => {
    const block = certify(twinChain, twinChain.produceBlock(txs, key(VALIDATOR), { timestampMs }));
    // Control: the artifact is a fully valid finalized block under the twin genesis.
    twinChain.validateFinalizedBlock(block, timestampMs);
    return block;
  };
  const futureMs = locked.timestampMs + CLIFF_MS + DAY_MS;
  const halfMs = locked.timestampMs + CLIFF_MS + LINEAR_MS / 2;
  const overspend = vestedAt(halfMs - locked.timestampMs) - 10 + 1; // amount + fee = vested + 1
  const built: Fixture = {
    version, locked, twin, blocks, height: target, nextMs, founderTx, liquidityTx,
    founderBlock: twinBlock([founderTx], nextMs),
    liquidityBlock: twinBlock([liquidityTx], nextMs),
    futureBlock: twinBlock([founderTx], futureMs),
    overspendBlock: twinBlock([transfer(locked, FOUNDER, overspend, version)], halfMs)
  };
  // Control for the overspend artifact: one atom less is exactly the vested amount and is accepted by the locked chain.
  const exact = certify(lockedChain, lockedChain.produceBlock([transfer(locked, FOUNDER, overspend - 1, version)], key(VALIDATOR), { timestampMs: halfMs }));
  lockedChain.validateFinalizedBlock(exact, halfMs);
  fixtures.set(version, built);
  return built;
}

/** Every lock-violating artifact is refused and nothing moved. */
function assertLocksHold(chain: ZyronChain, f: Fixture): void {
  assert.equal(chain.height, f.height);
  assert.equal(chain.tip.hash, f.blocks[f.blocks.length - 1]!.hash);
  assert.throws(() => chain.validateMempoolAdmission(f.founderTx, f.nextMs), VESTING, "founder mempool admission");
  assert.throws(() => chain.validateMempoolAdmission(f.liquidityTx, f.nextMs), LIQUIDITY_LOCKED, "liquidity mempool admission");
  assert.throws(() => chain.acceptBlock(structuredClone(f.founderBlock), f.nextMs), VESTING, "founder block");
  assert.throws(() => chain.acceptBlock(structuredClone(f.liquidityBlock), f.nextMs), LIQUIDITY_LOCKED, "liquidity block");
  assert.throws(() => chain.acceptBlock(structuredClone(f.futureBlock), f.nextMs), FUTURE, "future-stamped founder block");
  assert.throws(
    () => chain.acceptBlock(structuredClone(f.overspendBlock), f.overspendBlock.header.timestampMs),
    VESTING,
    "post-cliff overspend by one atom"
  );
  assert.equal(chain.height, f.height);
  assert.equal(chain.balance(addr(FOUNDER)), FOUNDER_ATOMS);
  assert.equal(chain.balance(addr(LIQUIDITY)), LIQUIDITY_ATOMS);
}

async function assertStoreLocksHold(store: ChainStore, f: Fixture): Promise<void> {
  assertLocksHold(store.chain, f);
  await assert.rejects(() => store.commitFinalizedBlock(structuredClone(f.founderBlock), f.nextMs), VESTING);
  await assert.rejects(() => store.commitFinalizedBlock(structuredClone(f.liquidityBlock), f.nextMs), LIQUIDITY_LOCKED);
  assert.equal(store.chain.height, f.height);
}

async function storeWith(genesis: GenesisConfig, dir: string, blocks: Block[]): Promise<ChainStore> {
  const store = await ChainStore.open(genesis, dir);
  for (const block of blocks) await store.commitFinalizedBlock(structuredClone(block), block.header.timestampMs);
  return store;
}

function anchorFor(chain: ZyronChain) {
  const snapshot = chain.snapshot();
  return { snapshot, anchor: { tipHash: snapshot.tip.hash, snapshotSha256: sha256Hex(canonicalJson(snapshot)) } };
}

/** Matches an error whose message, or any nested cause, matches `pattern`. */
function errorChain(pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    for (let current = error; current instanceof Error; current = current.cause) {
      if (pattern.test(current.message)) return true;
    }
    return false;
  };
}

async function withRoot(name: string, run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zyron-${name}-`));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const STATE_V2 = (version: number) => version >= 2;

for (const version of [1, 5, 6]) {
  test(`v${version}: baseline: the live chain refuses every lock-violating twin block`, () => {
    const f = fixture(version);
    const chain = new ZyronChain(f.locked);
    for (const block of f.blocks) chain.acceptBlock(structuredClone(block), block.header.timestampMs);
    assertLocksHold(chain, f);
    // Control: the twin genesis accepts the same founder block.
    const twin = new ZyronChain(f.twin);
    for (const block of f.blocks) twin.acceptBlock(structuredClone(block), block.header.timestampMs);
    twin.acceptBlock(structuredClone(f.founderBlock), f.nextMs);
    assert.equal(twin.balance(addr(FOUNDER)), FOUNDER_ATOMS - ZYN - 10);
  });

  test(`v${version}: full finalized-log replay refuses a lock-violating block appended to blocks.ndjson`, async () => {
    const f = fixture(version);
    await withRoot("lock-replay", async (root) => {
      const dir = join(root, "node");
      const store = await storeWith(f.locked, dir, f.blocks);
      await assertStoreLocksHold(store, f);
      // Restart with no checkpoint: the whole log is replayed.
      await assertStoreLocksHold(await ChainStore.open(f.locked, dir), f);
      await appendFile(join(dir, "blocks.ndjson"), `${canonicalJson(f.founderBlock)}\n`);
      await assert.rejects(() => ChainStore.open(f.locked, dir), errorChain(VESTING));
      // Control: the same tampered directory opens under the twin genesis at H+1.
      const twin = await ChainStore.open(f.twin, dir);
      assert.equal(twin.chain.height, f.height + 1);
      assert.equal(twin.chain.balance(addr(FOUNDER)), FOUNDER_ATOMS - ZYN - 10);
    });
  });

  test(`v${version}: P2P block sync from a twin-genesis peer stops before the lock-violating block`, async () => {
    const f = fixture(version);
    await withRoot("lock-p2p-sync", async (root) => {
      let source: Awaited<ReturnType<typeof createP2PNode>> | undefined;
      let follower: Awaited<ReturnType<typeof createP2PNode>> | undefined;
      try {
        const sourceDir = join(root, "twin-source");
        const followerDir = join(root, "follower");
        const twinStore = await storeWith(f.twin, sourceDir, f.blocks);
        await twinStore.commitFinalizedBlock(structuredClone(f.founderBlock), f.nextMs);
        assert.equal(twinStore.chain.height, f.height + 1);
        const followerStore = await ChainStore.open(f.locked, followerDir);
        const followerService = new NodeService(followerStore);
        const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
        const followerIdentity = await loadOrCreateNodeIdentity(followerDir);
        source = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
        follower = await createP2PNode(followerIdentity);
        await registerP2PSyncProtocol(source, sourceIdentity, new NodeService(twinStore));
        const address = source.getMultiaddrs()[0];
        assert.ok(address);
        // Same chain ID and genesis hash, so the handshake succeeds; the
        // follower must stop at the violating block whatever the sync reports.
        // The honest prefix is applied, then the violating block is refused.
        await assert.rejects(() => syncP2PFrom(follower!, address, followerIdentity, followerService), errorChain(VESTING));
        assert.equal(followerStore.chain.height, f.height);
        await assertStoreLocksHold(followerStore, f);
        await assertStoreLocksHold(await ChainStore.open(f.locked, followerDir), f);
      } finally {
        await Promise.allSettled([source?.stop(), follower?.stop()]);
      }
    });
  });

  if (version === 1) {
    test("v1: trusted snapshot restore keeps the locks; on-disk install and P2P checkpoints require State v2", async () => {
      const f = fixture(version);
      await withRoot("lock-snapshot-v1", async (root) => {
        const source = await storeWith(f.locked, join(root, "source"), f.blocks);
        const { snapshot, anchor } = anchorFor(source.chain);
        assertLocksHold(ZyronChain.fromTrustedSnapshot(f.locked, structuredClone(snapshot), anchor), f);
        await assert.rejects(
          () => ChainStore.installTrustedSnapshot(f.locked, join(root, "installed"), structuredClone(snapshot), anchor),
          /Trusted snapshot install requires active State v2/
        );
        await assert.rejects(() => source.pruneFinalizedHistory(), /Pruning requires active State v2/);
      });
    });

    test("v1: recovery-checkpoint reopen keeps the locks and refuses a violating block appended after it", async () => {
      const f = fixture(version);
      await withRoot("lock-recovery-v1", async (root) => {
        const dir = join(root, "node");
        const store = await storeWith(f.locked, dir, f.blocks);
        const written = await store.writeRecoveryCheckpoint();
        assert.equal(written.height, f.height);
        const reopened = await ChainStore.open(f.locked, dir);
        assert.equal(reopened.recoveredFromCheckpointHeight, f.height);
        await assertStoreLocksHold(reopened, f);
        await appendFile(join(dir, "blocks.ndjson"), `${canonicalJson(f.founderBlock)}\n`);
        await assert.rejects(() => ChainStore.open(f.locked, dir), errorChain(VESTING));
      });
    });
    continue;
  }

  test(`v${version}: trusted snapshot install (and reopen of the installed node) keeps the locks`, async () => {
    const f = fixture(version);
    await withRoot("lock-snapshot", async (root) => {
      const source = await storeWith(f.locked, join(root, "source"), f.blocks);
      const { snapshot, anchor } = anchorFor(source.chain);
      const restored = ZyronChain.fromTrustedSnapshot(f.locked, structuredClone(snapshot), anchor);
      assertLocksHold(restored, f);
      const installedDir = join(root, "installed");
      const installed = await ChainStore.installTrustedSnapshot(f.locked, installedDir, structuredClone(snapshot), anchor);
      await assertStoreLocksHold(installed, f);
      // Reopen goes through the installed recovery checkpoint.
      const reopened = await ChainStore.open(f.locked, installedDir);
      assert.equal(reopened.recoveredFromCheckpointHeight, f.height);
      await assertStoreLocksHold(reopened, f);
      // A violating block appended after the installed checkpoint is refused on reopen.
      await appendFile(join(installedDir, "blocks.ndjson"), `${canonicalJson(f.liquidityBlock)}\n`);
      await assert.rejects(() => ChainStore.open(f.locked, installedDir), errorChain(LIQUIDITY_LOCKED));
    });
  });

  test(`v${version}: recovery-checkpoint reopen over pruned history keeps the locks`, async () => {
    const f = fixture(version);
    await withRoot("lock-recovery", async (root) => {
      const dir = join(root, "node");
      const store = await storeWith(f.locked, dir, f.blocks);
      const pruned = await store.pruneFinalizedHistory();
      assert.equal(pruned.prunedThroughHeight, f.height);
      const reopened = await ChainStore.open(f.locked, dir);
      assert.equal(reopened.recoveredFromCheckpointHeight, f.height);
      assert.equal(reopened.firstStoredHeight, f.height + 1);
      await assertStoreLocksHold(reopened, f);
      // No full-replay fallback exists for pruned history: the appended block
      // must be validated on top of the checkpoint state and refused.
      await appendFile(join(dir, "blocks.ndjson"), `${canonicalJson(f.founderBlock)}\n`);
      await assert.rejects(() => ChainStore.open(f.locked, dir), errorChain(VESTING));
    });
  });

  test(`v${version}: P2P checkpoint transfer then install keeps the locks`, async () => {
    const f = fixture(version);
    await withRoot("lock-p2p-checkpoint", async (root) => {
      let source: Awaited<ReturnType<typeof createP2PNode>> | undefined;
      let client: Awaited<ReturnType<typeof createP2PNode>> | undefined;
      try {
        const sourceDir = join(root, "source");
        const store = await storeWith(f.locked, sourceDir, f.blocks);
        const { anchor } = anchorFor(store.chain);
        const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
        const clientIdentity = await loadOrCreateNodeIdentity(join(root, "client-identity"));
        source = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
        client = await createP2PNode(clientIdentity);
        await registerP2PCheckpointProtocol(source, sourceIdentity, new NodeService(store));
        const address = source.getMultiaddrs()[0];
        assert.ok(address);
        const fetched = await fetchTrustedSnapshotFromPeer(client, address, clientIdentity, f.locked, anchor);
        const installedDir = join(root, "installed");
        await assertStoreLocksHold(await ChainStore.installTrustedSnapshot(f.locked, installedDir, fetched, anchor), f);
        await assertStoreLocksHold(await ChainStore.open(f.locked, installedDir), f);
      } finally {
        await Promise.allSettled([source?.stop(), client?.stop()]);
      }
    });
  });

  if (!STATE_V2(version)) continue;

  test(`v${version}: portable State-v2 install keeps the locks`, async () => {
    const f = fixture(version);
    await withRoot("lock-portable", async (root) => {
      const source = await storeWith(f.locked, join(root, "source"), f.blocks);
      const { snapshot, anchor } = anchorFor(source.chain);
      const state = source.chain.stateV2ForPersistence();
      assert.ok(state);
      const bundle = createStateV2PortableBundle(state, snapshot.state, {
        validatorSchedule: snapshot.validatorSchedule,
        protocolSchedule: snapshot.protocolSchedule
      });
      assertLocksHold(ZyronChain.fromTrustedPortableState(f.locked, structuredClone(snapshot.tip), bundle, anchor), f);
      const installedDir = join(root, "installed");
      await assertStoreLocksHold(
        await ChainStore.installTrustedPortableState(f.locked, installedDir, structuredClone(snapshot.tip), bundle, anchor),
        f
      );
      await assertStoreLocksHold(await ChainStore.open(f.locked, installedDir), f);
    });
  });

  test(`v${version}: P2P portable state sync then install keeps the locks`, async () => {
    const f = fixture(version);
    await withRoot("lock-p2p-state", async (root) => {
      let source: Awaited<ReturnType<typeof createP2PNode>> | undefined;
      let client: Awaited<ReturnType<typeof createP2PNode>> | undefined;
      try {
        const sourceDir = join(root, "source");
        const store = await storeWith(f.locked, sourceDir, f.blocks);
        const { anchor } = anchorFor(store.chain);
        const sourceIdentity = await loadOrCreateNodeIdentity(sourceDir);
        const clientIdentity = await loadOrCreateNodeIdentity(join(root, "client-identity"));
        source = await createP2PNode(sourceIdentity, { listen: ["/ip4/127.0.0.1/tcp/0"] });
        client = await createP2PNode(clientIdentity);
        await registerP2PStateProtocol(source, sourceIdentity, new NodeService(store));
        const address = source.getMultiaddrs()[0];
        assert.ok(address);
        const fetched = await fetchTrustedPortableStateFromPeer(client, address, clientIdentity, f.locked, anchor);
        const installedDir = join(root, "installed");
        await assertStoreLocksHold(
          await ChainStore.installTrustedPortableState(f.locked, installedDir, fetched.tip, fetched.bundle, anchor),
          f
        );
        await assertStoreLocksHold(await ChainStore.open(f.locked, installedDir), f);
      } finally {
        await Promise.allSettled([source?.stop(), client?.stop()]);
      }
    });
  });

  test(`v${version}: State-v2 store rebuild on reopen (corrupt root metadata) keeps the locks`, async () => {
    const f = fixture(version);
    await withRoot("lock-state-v2-replay", async (root) => {
      const dir = join(root, "node");
      await storeWith(f.locked, dir, f.blocks);
      await writeFile(join(dir, "state-v2.root.json"), "{not json");
      const reopened = await ChainStore.open(f.locked, dir);
      assert.equal(reopened.recoveredStateV2FromCorruption, true);
      assert.equal(reopened.chain.stateV2ForPersistence()?.root(), f.blocks[f.blocks.length - 1]!.header.stateRoot);
      await assertStoreLocksHold(reopened, f);
      await appendFile(join(dir, "blocks.ndjson"), `${canonicalJson(f.liquidityBlock)}\n`);
      await writeFile(join(dir, "state-v2.root.json"), "{not json");
      await assert.rejects(() => ChainStore.open(f.locked, dir), errorChain(LIQUIDITY_LOCKED));
    });
  });
}
