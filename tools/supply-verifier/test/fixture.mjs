// Deterministic fixture chain and fake read-only endpoints for the supply
// verifier tests. Uses TEST keys derived from small integers only.
import { createServer } from "node:http";

import { l1 } from "../src/l1.mjs";

const { block, chain: chainMod, consensusV6, crypto, feePolicy, publicDistribution, transaction, types } = await l1();
const ZYN = types.ATOMS_PER_ZYN;
const key = (n) => n.toString(16).padStart(64, "0");
const pub = (n) => crypto.publicKeyFromPrivate(key(n));
const addr = (n) => crypto.addressFromPublicKey(pub(n));

const VALIDATOR_IDS = [71, 80, 81, 82];
const FOUNDER = 73, PUBLIC_DISTRIBUTION = 74, LIQUIDITY = 75, ECOSYSTEM = 76, ALICE = 90, BOB = 91;
const IDS = [...VALIDATOR_IDS, PUBLIC_DISTRIBUTION, ALICE, BOB];
export const FEE = feePolicy.FIXED_TRANSFER_FEE_ATOMS;

export function fixtureGenesis({ chainId = "zyron-supply-verifier-test", founderZyn = 5_000_000, profile = true } = {}) {
  const genesis = {
    chainId,
    timestampMs: 1_700_000_000_000,
    validators: VALIDATOR_IDS.map((id) => ({ address: addr(id), publicKey: pub(id) })),
    activityOracles: [pub(72), pub(78), pub(79)],
    activityOracleThreshold: 2,
    activityOraclePolicy: "threshold-v1",
    activityPool: addr(ECOSYSTEM),
    allocations: [
      { address: addr(FOUNDER), amountAtoms: founderZyn * ZYN },
      { address: addr(PUBLIC_DISTRIBUTION), amountAtoms: 20_000_000 * ZYN },
      { address: addr(LIQUIDITY), amountAtoms: 20_000_000 * ZYN },
      { address: addr(ECOSYSTEM), amountAtoms: 5_000_000 * ZYN }
    ],
    allocationLocks: { founderVesting: addr(FOUNDER), permanentLiquidity: addr(LIQUIDITY) },
    publicDistributionRelease: publicDistribution.defaultPublicDistributionRelease(addr(PUBLIC_DISTRIBUTION)),
    launchProfile: "fixed-supply-v1",
    feePolicy: { version: "fixed-fee-v1", fixedTransferFeeAtoms: FEE }
  };
  if (!profile) {
    // Legacy (non fixed-supply-v1) genesis: consensus does not pin 50M, so the
    // verifier itself must reject a supply other than 50M. Full fee burn.
    for (const field of ["launchProfile", "feePolicy", "publicDistributionRelease", "activityOraclePolicy", "activityOracleThreshold", "allocationLocks"]) delete genesis[field];
    genesis.activityOracles = genesis.activityOracles.slice(0, 1);
  }
  return genesis;
}

function idFor(address) {
  const id = IDS.find((candidate) => addr(candidate) === address);
  if (id === undefined) throw new Error("unexpected address");
  return id;
}

function finalize(chain, txs, timestampMs) {
  const height = chain.height + 1;
  const validators = chain.validatorsAt(height);
  const proposer = block.expectedValidator(validators, height, 0);
  let next = chain.produceBlock(txs, key(idFor(proposer.address)), { timestampMs });
  const quorum = validators.slice(0, block.validatorQuorumSize(validators.length));
  if (consensusV6.isConsensusV6(chain.protocolVersionAt(next.header.height))) {
    next.commitRound = 0;
    next.attestations = quorum.map((v) => ({
      validator: v.address, publicKey: v.publicKey,
      signature: consensusV6.signV6(consensusV6.V6_COMMIT_VOTE_DOMAIN, consensusV6.votePayload(next.header.chainId, next.header.height, 0, next.hash), key(idFor(v.address)))
    }));
  } else {
    for (const v of quorum) next = chain.attestBlock(next, key(idFor(v.address)));
  }
  chain.acceptBlock(next, timestampMs);
  return next;
}

function transfer(genesis, from, nonce, to, amountAtoms, timestampMs) {
  return transaction.createTransfer({ chainId: genesis.chainId, nonce, sender: addr(from), receiver: addr(to), amountAtoms, feeAtoms: FEE, timestampMs }, key(from), pub(from));
}

/** Builds a finalized chain: transfers with fixed fees (half burned) across `blocks` blocks. */
export function buildFixtureChain(options = {}) {
  const genesis = fixtureGenesis(options);
  const chain = new chainMod.ZyronChain(genesis);
  const blocks = [];
  let t = genesis.timestampMs + 400 * 86_400_000;
  let pdNonce = 0, aliceNonce = 0;
  const count = options.blocks ?? 5;
  for (let i = 0; i < count; i += 1) {
    t += 10_000;
    const txs = [transfer(genesis, PUBLIC_DISTRIBUTION, ++pdNonce, ALICE, 3 * ZYN, t - 1)];
    if (i > 0) txs.push(transfer(genesis, ALICE, ++aliceNonce, BOB, 1 * ZYN, t - 1));
    blocks.push(finalize(chain, txs, t));
  }
  return { genesis, genesisHash: chain.genesisHash, blocks, chain };
}

/**
 * Fake node RPC: GET /status and GET /blocks?from=&limit= (the node and
 * gateway /peer surface), plus GET /genesis. `mutate` may rewrite responses.
 */
export async function startEndpoint(fixture, { mutateBlocks, statusOverride, genesisHashOverride, failAll } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://x");
    const send = (code, body) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
    if (failAll) return send(500, { error: "down" });
    const tip = fixture.blocks.at(-1);
    if (url.pathname === "/status") {
      return send(200, { chainId: fixture.genesis.chainId, genesisHash: genesisHashOverride ?? fixture.genesisHash, height: tip.header.height, tipHash: tip.hash, ...statusOverride });
    }
    if (url.pathname === "/genesis") return send(200, { genesisHash: fixture.genesisHash, genesis: fixture.genesis });
    if (url.pathname === "/blocks") {
      const from = Number(url.searchParams.get("from"));
      const limit = Number(url.searchParams.get("limit") ?? 100);
      let blocks = structuredClone(fixture.blocks.slice(from - 1, from - 1 + limit));
      if (mutateBlocks) blocks = mutateBlocks(blocks);
      return send(200, { blocks });
    }
    return send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A URL nothing listens on. */
export async function unreachableUrl() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}
