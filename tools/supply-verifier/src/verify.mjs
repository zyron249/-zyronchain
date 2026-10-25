// Public fixed-supply verifier (read-only). See docs/SUPPLY_VERIFIER.md.
//
// Replays the chain from the pinned genesis with the node's own consensus code
// (l1/dist/src: block hashes, proposer and quorum signatures, state roots) and
// reconciles every supply bucket to exactly 50,000,000 ZYN in BigInt atoms.
// Blocks are fetched from at least two independent endpoints and the header
// hash at every height must agree. Every problem fails closed with a reason.
import { l1 } from "./l1.mjs";

/** Open-testnet genesis pinned in docs/OPEN_TESTNET.md and website/verify/session.js. */
export const PINNED_GENESIS_HASH = "e0212e574271ef1de78ad148965e3d1a4a04afca3071d3c374d29ae5a6d4a8ad";
export const ATOMS_PER_ZYN = 100_000_000n;
export const FIXED_SUPPLY_ATOMS = 50_000_000n * ATOMS_PER_ZYN;
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_TIP_DRIFT = 3;
/** Printed in every report; see docs/SUPPLY_VERIFIER.md "Trust assumptions". */
export const TRUST_ASSUMPTIONS = Object.freeze([
  "This verifier trusts the l1 consensus code at the verified commit (l1/dist/src); it is not an independent second implementation.",
  "Endpoints are not proven independent: two URLs may front the same node or operator, and the tool cannot detect that."
]);
const HASH = /^[0-9a-f]{64}$/;

export class VerificationError extends Error {
  constructor(message) { super(message); this.name = "VerificationError"; }
}
const fail = (message) => { throw new VerificationError(message); };

/**
 * Pure supply reconciliation. All inputs are BigInt atoms.
 * Invariants: genesis supply == 50M ZYN, and
 * sum(balances) + pending + burned == genesis supply (no mint, no loss),
 * with locked (vesting / locked reserves) a subset of balances.
 */
export function reconcile({ genesisSupplyAtoms, burnedAtoms, balances, lockedAtoms = 0n, pendingAtoms = 0n }) {
  for (const [name, value] of Object.entries({ genesisSupplyAtoms, burnedAtoms, lockedAtoms, pendingAtoms })) {
    if (typeof value !== "bigint") fail(`${name} must be a BigInt`);
    if (value < 0n) fail(`${name} is negative`);
  }
  if (genesisSupplyAtoms !== FIXED_SUPPLY_ATOMS) {
    fail(`genesis supply ${genesisSupplyAtoms} atoms is not exactly 50000000 ZYN (${FIXED_SUPPLY_ATOMS} atoms)`);
  }
  let balancesAtoms = 0n;
  for (const balance of balances) {
    if (typeof balance !== "bigint") fail("balance must be a BigInt");
    if (balance < 0n) fail("negative account balance");
    balancesAtoms += balance;
  }
  if (lockedAtoms > balancesAtoms) fail(`locked atoms ${lockedAtoms} exceed total balances ${balancesAtoms}`);
  const totalAtoms = balancesAtoms + pendingAtoms + burnedAtoms;
  if (totalAtoms !== genesisSupplyAtoms) {
    fail(`supply does not reconcile: balances ${balancesAtoms} + pending ${pendingAtoms} + burned ${burnedAtoms} = ${totalAtoms}, expected ${genesisSupplyAtoms}`);
  }
  return { genesisSupplyAtoms, balancesAtoms, lockedAtoms, spendableAtoms: balancesAtoms - lockedAtoms, pendingAtoms, burnedAtoms, totalAtoms };
}

function normalizeEndpoint(value) {
  let url;
  try { url = new URL(String(value)); } catch { fail(`invalid endpoint URL: ${value}`); }
  if (url.protocol !== "https:" && url.protocol !== "http:") fail(`endpoint must be http(s): ${value}`);
  if (url.search || url.hash) fail(`endpoint must not carry a query or fragment: ${value}`);
  return url.href.replace(/\/+$/, "");
}

async function getJson(endpoint, path, { fetchImpl, timeoutMs }) {
  let response;
  try {
    response = await fetchImpl(`${endpoint}${path}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" }, redirect: "error" });
  } catch (error) {
    fail(`endpoint ${endpoint} unreachable for ${path}: ${error.cause?.code ?? error.message}`);
  }
  if (response.status !== 200) fail(`endpoint ${endpoint} returned HTTP ${response.status} for ${path}`);
  const text = await readCapped(response, endpoint, path);
  try { return JSON.parse(text); } catch { fail(`endpoint ${endpoint} returned invalid JSON for ${path}`); }
}

/** Streams the body with a running byte cap and aborts the read as soon as it is exceeded. */
export async function readCapped(response, endpoint, path) {
  const tooLarge = () => fail(`endpoint ${endpoint} response for ${path} exceeds ${MAX_RESPONSE_BYTES} bytes`);
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    tooLarge();
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      let step;
      try { step = await reader.read(); } catch (error) { fail(`endpoint ${endpoint} failed reading ${path}: ${error.message}`); }
      if (step.done) break;
      total += step.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        tooLarge();
      }
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock?.();
  }
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); } catch { fail(`endpoint ${endpoint} returned invalid UTF-8 for ${path}`); }
}

/**
 * @param {object} options
 * @param {string[]} options.endpoints  node RPC bases serving GET /status and GET /blocks (e.g. <gateway>/peer)
 * @param {object} options.genesis      genesis config (its hash must equal expectedGenesisHash)
 * @param {string} [options.expectedGenesisHash] defaults to PINNED_GENESIS_HASH
 * @param {number} [options.toHeight]   verify up to this height (default: lowest endpoint tip)
 * @param {number} [options.maxTipDrift] warn (not fail) when endpoint tips differ by more blocks (default 3)
 */
export async function verifySupply(options) {
  const { genesis, toHeight, onProgress } = options;
  const expectedGenesisHash = options.expectedGenesisHash ?? PINNED_GENESIS_HASH;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const io = { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS };
  if (!HASH.test(expectedGenesisHash)) fail("expected genesis hash must be 64 lowercase hex characters");
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) fail("batch size must be 1..100");
  const maxTipDrift = options.maxTipDrift ?? DEFAULT_MAX_TIP_DRIFT;
  if (!Number.isSafeInteger(maxTipDrift) || maxTipDrift < 0) fail("max tip drift must be a non-negative integer");
  const warnings = [];

  const endpoints = [...new Set((options.endpoints ?? []).map(normalizeEndpoint))];
  if (endpoints.length < 2) fail(`at least 2 distinct endpoints are required to cross-check headers (got ${endpoints.length})`);

  const { chain: chainMod, block: blockMod, feePolicy, allocationLocks, types } = await l1();
  if (BigInt(types.MAX_SUPPLY_ATOMS) !== FIXED_SUPPLY_ATOMS) fail("l1 MAX_SUPPLY_ATOMS is not 50000000 ZYN");

  // 1. Genesis: hash must equal the pin, supply must be exactly 50M.
  if (!genesis || typeof genesis !== "object") fail("genesis config is required");
  let chain;
  try { chain = new chainMod.ZyronChain(genesis); } catch (error) { fail(`genesis is invalid: ${error.message}`); }
  if (chain.genesisHash !== expectedGenesisHash) fail(`genesis hash mismatch: genesis hashes to ${chain.genesisHash}, pinned ${expectedGenesisHash}`);
  let genesisSupplyAtoms = 0n;
  for (const allocation of genesis.allocations) genesisSupplyAtoms += BigInt(allocation.amountAtoms);
  if (genesisSupplyAtoms !== BigInt(chain.genesisSupplyAtoms())) fail("genesis allocation sum disagrees with the replayed genesis state");
  if (genesisSupplyAtoms !== FIXED_SUPPLY_ATOMS) fail(`genesis supply ${genesisSupplyAtoms} atoms is not exactly 50000000 ZYN (${FIXED_SUPPLY_ATOMS} atoms)`);

  // 2. Every endpoint must be on this chain; verify up to the lowest tip.
  const statuses = await Promise.all(endpoints.map((endpoint) => getJson(endpoint, "/status", io)));
  statuses.forEach((status, index) => {
    if (status?.chainId !== genesis.chainId) fail(`endpoint ${endpoints[index]} reports chain ID ${status?.chainId}, expected ${genesis.chainId}`);
    if (status?.genesisHash !== expectedGenesisHash) fail(`endpoint ${endpoints[index]} reports genesis hash ${status?.genesisHash}, pinned ${expectedGenesisHash}`);
    if (!Number.isSafeInteger(status.height) || status.height < 0) fail(`endpoint ${endpoints[index]} reports an invalid height`);
  });
  const lowestTip = Math.min(...statuses.map((status) => status.height));
  const tipDrift = Math.max(...statuses.map((status) => status.height)) - lowestTip;
  if (tipDrift > maxTipDrift) {
    warnings.push(`endpoint tips differ by ${tipDrift} blocks (more than ${maxTipDrift}): ${endpoints.map((e, i) => `${e}=${statuses[i].height}`).join(", ")}; verifying up to the lowest tip. A lagging or forked endpoint weakens the cross-check.`);
  }
  const target = toHeight ?? lowestTip;
  if (!Number.isSafeInteger(target) || target < 0) fail("target height must be a non-negative integer");
  if (target > lowestTip) fail(`target height ${target} is above the lowest endpoint tip ${lowestTip}`);

  // 3. Replay with cross-checked headers.
  const burnPolicy = feePolicy.readFeePolicy(genesis);
  let burnedAtoms = 0n;
  for (let from = 1; from <= target; from += batchSize) {
    const limit = Math.min(batchSize, target - from + 1);
    const responses = await Promise.all(endpoints.map((endpoint) => getJson(endpoint, `/blocks?from=${from}&limit=${limit}`, io)));
    const batches = responses.map((body, index) => {
      const blocks = body?.blocks;
      if (!Array.isArray(blocks)) fail(`endpoint ${endpoints[index]} returned no block list for heights ${from}..${from + limit - 1}`);
      for (let offset = 0; offset < limit; offset += 1) {
        const height = from + offset;
        if (blocks[offset]?.header?.height !== height) fail(`endpoint ${endpoints[index]} is missing data: expected block ${height}`);
      }
      return blocks;
    });
    for (let offset = 0; offset < limit; offset += 1) {
      const height = from + offset;
      const candidates = batches.map((blocks) => blocks[offset]);
      const hashes = candidates.map((candidate, index) => {
        let recomputed;
        try { recomputed = blockMod.blockHash(candidate.header); } catch (error) { fail(`endpoint ${endpoints[index]} block ${height} header is malformed: ${error.message}`); }
        if (candidate.hash !== recomputed) fail(`header hash mismatch at height ${height}: endpoint ${endpoints[index]} claims ${candidate.hash}, header hashes to ${recomputed}`);
        return recomputed;
      });
      if (new Set(hashes).size !== 1) fail(`header hash mismatch at height ${height}: ${endpoints.map((e, i) => `${e}=${hashes[i]}`).join(", ")}`);
      const block = candidates[0];
      try { chain.acceptBlock(block, Date.now()); } catch (error) { fail(`replay rejected block ${height}: ${error.message}`); }
      for (const tx of block.transactions) {
        const fee = BigInt(tx.feeAtoms ?? 0);
        if (tx.kind !== "transfer") { if (fee !== 0n) fail(`non-transfer transaction with a fee at height ${height}`); continue; }
        burnedAtoms += burnPolicy ? BigInt(feePolicy.splitFixedFee(tx.feeAtoms).burnAtoms) : fee;
      }
    }
    onProgress?.({ height: from + limit - 1, target });
  }
  if (chain.height !== target) fail(`replay stopped at ${chain.height}, expected ${target}`);

  // 4. Buckets from the replayed state.
  const accounts = chain.getState().snapshot().accounts;
  const lockContext = chain.allocationLocksAt(chain.tip.header.timestampMs);
  let lockedAtoms = 0n;
  const lockedAccounts = [];
  for (const account of accounts) {
    const spendable = allocationLocks.spendableAtoms(lockContext, account.address, account.balanceAtoms);
    const locked = BigInt(account.balanceAtoms) - BigInt(spendable);
    if (locked > 0n) { lockedAtoms += locked; lockedAccounts.push({ address: account.address, lockedAtoms: locked.toString() }); }
  }
  // The protocol has no escrow or pending-balance state: a transaction moves
  // value only when its block is final, so mempool contents are not supply.
  // TODO(feature 1, reversible transfers): once LedgerState gains escrow state
  // (e.g. pendingTransfers), sum it here from the replayed snapshot. The
  // "pendingAtoms guard" test fails until this is done.
  const pendingAtoms = 0n;
  const balances = accounts.map((account) => BigInt(account.balanceAtoms));
  const result = reconcile({ genesisSupplyAtoms, burnedAtoms, balances, lockedAtoms, pendingAtoms });
  if (BigInt(chain.totalSupplyAtoms()) !== result.balancesAtoms) fail("replayed ledger total disagrees with the account sum");

  return {
    ok: true,
    chainId: genesis.chainId,
    genesisHash: chain.genesisHash,
    height: chain.height,
    tipHash: chain.tip.hash,
    endpointsChecked: endpoints.length,
    endpointTips: endpoints.map((endpoint, index) => ({ endpoint, height: statuses[index].height })),
    genesisSupplyAtoms: genesisSupplyAtoms.toString(),
    totalAtoms: result.totalAtoms.toString(),
    buckets: {
      balancesAtoms: result.balancesAtoms.toString(),
      spendableAtoms: result.spendableAtoms.toString(),
      lockedAtoms: result.lockedAtoms.toString(),
      pendingAtoms: result.pendingAtoms.toString(),
      burnedAtoms: result.burnedAtoms.toString()
    },
    lockedAccounts,
    accountCount: accounts.length,
    maxTipDrift,
    warnings,
    trustAssumptions: [...TRUST_ASSUMPTIONS]
  };
}
