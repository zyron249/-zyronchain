// Optional durable state for the no-value wallet testnet RPC.
//
// Enabled only when ZYRON_TESTNET_DATABASE_URL is set (Postgres, typically a
// Neon free database that is NOT the game database). Without it, or if the
// database cannot be reached quickly, the RPC keeps today's ephemeral behavior.
//
// Restore prefers the normal mempool path: stored transfers are checked with
// ZyronChain.validateMempoolAdmission and the mempool nonce rule, then submitted
// with POST /tx after the validator is up. That keeps balances and next nonces,
// so a transfer signed against the pre-restart nonce still matches. Chain checks
// are not weakened.
//
// If that check fails because of a timestamp or activity-epoch window, those
// bytes cannot be included again. The fallback folds the transfers with the
// ledger's own apply rules (fees burn, no mint) and starts from genesis
// allocations equal to the folded balances. A genesis allocation is only
// {address, amountAtoms}; consensus rejects any other field, so a nonce cannot
// be written into it. After this fallback the chain reports nonce 0. The folded
// nonce is stored beside the allocations as a record, not as chain state.
// Signers must use the nonce GET /nonce reports (the /testnet/ page shows
// next nonce = nonce + 1). The phone wallet does not connect. Rows at or below
// the compaction point are not replayed, so they are not paid twice on top of
// the folded balances. Total supply is never allowed above the configured test
// genesis amount.
import { ZyronChain } from "../dist/src/chain.js";
import { LedgerState } from "../dist/src/state.js";

export const DURABLE_CONNECT_TIMEOUT_MS = 3_000;
export const DURABLE_QUERY_TIMEOUT_MS = 4_000;
const MAX_RESTORED_TRANSACTIONS = 50_000;
const ADDRESS = /^ZYN[0-9a-f]{40}$/;

// Activity-epoch and block-timestamp windows only. "Transaction nonce outside
// mempool window" is a sequencing failure, not this fallback.
export function isTimestampOrEpochWindowError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /activity epoch|too far in future|timestamp outside/i.test(message);
}

export function assertReplayable(chain, tx, nowMs) {
  chain.validateMempoolAdmission(tx, nowMs);
  const stateNonce = chain.nonce(tx.sender);
  if (tx.nonce !== stateNonce + 1) throw new Error("Transaction nonce is not the next confirmed nonce");
  chain.validatePending([tx], Math.max(nowMs, chain.tip.header.timestampMs + 1));
}

export function advanceRestoredChain(chain, tx, validatorPrivateKey, nowMs) {
  const timestampMs = Math.max(nowMs, chain.tip.header.timestampMs + 1);
  let block = chain.produceBlock([tx], validatorPrivateKey, { timestampMs, round: 0 });
  block = chain.attestBlock(block, validatorPrivateKey);
  chain.acceptBlock(block, timestampMs);
}

export function foldIncludedTransfers(genesis, transactions) {
  const state = LedgerState.fromGenesis(genesis);
  const original = state.totalSupplyAtoms();
  for (const tx of transactions) {
    if (!tx || tx.kind !== "transfer") throw new Error("durable restore only folds included transfers");
    state.apply(tx, genesis.activityPool, undefined, genesis);
  }
  const supply = state.totalSupplyAtoms();
  if (!Number.isSafeInteger(supply) || supply > original) {
    throw new Error("restore would exceed configured test genesis supply");
  }
  return { accounts: state.snapshot().accounts, supplyAtoms: supply, configuredSupplyAtoms: original };
}

export function allocationsFromAccounts(accounts, validatorAddress) {
  const allocations = accounts
    .filter((account) => account.balanceAtoms > 0)
    .map((account) => ({ address: account.address, amountAtoms: account.balanceAtoms }))
    .sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
  if (allocations.length === 0) allocations.push({ address: validatorAddress, amountAtoms: 0 });
  return allocations;
}

export function sumAtoms(entries, field = "amountAtoms") {
  let sum = 0;
  for (const entry of entries) {
    const amount = entry[field];
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("invalid restored balance");
    sum += amount;
    if (!Number.isSafeInteger(sum)) throw new Error("invalid restored balance");
  }
  return sum;
}

export function assertWithinConfiguredSupply(atoms, configuredSupplyAtoms) {
  if (!Number.isSafeInteger(atoms) || atoms < 0 || atoms > configuredSupplyAtoms) {
    throw new Error("restore would exceed configured test genesis supply");
  }
}

function noncesFromAccounts(accounts) {
  return accounts
    .filter((account) => account.nonce > 0)
    .map((account) => ({ address: account.address, nonce: account.nonce }))
    .sort((left, right) => (left.address < right.address ? -1 : left.address > right.address ? 1 : 0));
}

function validateAllocations(allocations, configuredSupplyAtoms) {
  if (!Array.isArray(allocations) || allocations.length === 0) throw new Error("invalid durable baseline");
  const seen = new Set();
  for (const allocation of allocations) {
    if (!allocation || typeof allocation.address !== "string" || !ADDRESS.test(allocation.address)) {
      throw new Error("invalid durable baseline");
    }
    if (seen.has(allocation.address)) throw new Error("invalid durable baseline");
    seen.add(allocation.address);
    if (!Number.isSafeInteger(allocation.amountAtoms) || allocation.amountAtoms < 0) {
      throw new Error("invalid durable baseline");
    }
  }
  assertWithinConfiguredSupply(sumAtoms(allocations), configuredSupplyAtoms);
}

function workingGenesis(genesis, allocations) {
  const next = { ...genesis, allocations: allocations.map((allocation) => ({ ...allocation })) };
  // Reject a document chain validation would reject, before it is written.
  void new ZyronChain(next).genesisHash;
  return next;
}

/**
 * Decide how this process should recover.
 *
 * `entries` are uncompacted included transfers in seq order: `{ seq, tx }`.
 * `baseline` is a previous genesis-fallback snapshot, or null.
 * The returned genesis is what the validator must start from. `entries` is
 * empty unless mode is "replay". `baselineToSave` is set only for a new
 * compaction and must be persisted before the process accepts new transfers.
 */
export function planStateRestore({ genesis, entries, baseline, nowMs, validatorPrivateKey, configuredSupplyAtoms, admit }) {
  const list = entries ?? [];
  if (list.length > MAX_RESTORED_TRANSACTIONS) {
    return abort(genesis, "too many stored transactions to restore safely", true);
  }
  let working = genesis;
  if (baseline) {
    try {
      validateAllocations(baseline.allocations, configuredSupplyAtoms);
      working = workingGenesis(genesis, baseline.allocations);
    } catch (error) {
      return abort(genesis, error instanceof Error ? error.message : String(error), true);
    }
  }
  if (list.length === 0) {
    return {
      mode: baseline ? "genesis" : "none",
      genesis: working,
      entries: [],
      restoredTxCount: 0,
      restoredAccounts: baseline ? baseline.allocations.length : 0,
      baselineToSave: null,
      recordedNonces: baseline?.nonces ?? [],
      error: null
    };
  }
  const probe = new ZyronChain(structuredClone(working));
  for (const entry of list) {
    try {
      if (admit) admit(probe, entry.tx, nowMs);
      else {
        assertReplayable(probe, entry.tx, nowMs);
        advanceRestoredChain(probe, entry.tx, validatorPrivateKey, nowMs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!isTimestampOrEpochWindowError(error)) {
        return {
          mode: baseline ? "genesis" : "abort",
          severe: !baseline,
          genesis: working,
          entries: [],
          restoredTxCount: 0,
          restoredAccounts: baseline ? baseline.allocations.length : 0,
          baselineToSave: null,
          recordedNonces: baseline?.nonces ?? [],
          error: message
        };
      }
      try {
        const folded = foldIncludedTransfers(working, list.map((item) => item.tx));
        assertWithinConfiguredSupply(folded.supplyAtoms, configuredSupplyAtoms);
        const allocations = allocationsFromAccounts(folded.accounts, genesis.validators[0].address);
        const next = workingGenesis(genesis, allocations);
        const last = list[list.length - 1];
        return {
          mode: "genesis",
          severe: false,
          genesis: next,
          entries: [],
          restoredTxCount: list.length,
          restoredAccounts: folded.accounts.filter((account) => account.balanceAtoms > 0 || account.nonce > 0).length,
          baselineToSave: {
            compactedThroughSeq: last.seq,
            allocations,
            nonces: noncesFromAccounts(folded.accounts)
          },
          recordedNonces: noncesFromAccounts(folded.accounts),
          error: message
        };
      } catch (foldError) {
        return abort(genesis, foldError instanceof Error ? foldError.message : String(foldError), true);
      }
    }
  }
  return {
    mode: "replay",
    severe: false,
    genesis: working,
    entries: list,
    restoredTxCount: list.length,
    restoredAccounts: touchedAccounts(list),
    baselineToSave: null,
    recordedNonces: [],
    error: null
  };
}

function abort(genesis, error, severe) {
  return {
    mode: "abort",
    severe,
    genesis,
    entries: [],
    restoredTxCount: 0,
    restoredAccounts: 0,
    baselineToSave: null,
    recordedNonces: [],
    error
  };
}

function touchedAccounts(entries) {
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry.tx?.sender === "string") seen.add(entry.tx.sender);
    if (typeof entry.tx?.receiver === "string") seen.add(entry.tx.receiver);
  }
  return seen.size;
}

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS wallet_testnet_tx (
  chain_id text NOT NULL,
  seq bigserial NOT NULL,
  raw_tx jsonb NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_testnet_tx_chain_txid_idx
  ON wallet_testnet_tx (chain_id, (raw_tx->>'txid'));
CREATE TABLE IF NOT EXISTS wallet_testnet_baseline (
  chain_id text PRIMARY KEY,
  compacted_through_seq bigint NOT NULL,
  accounts jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallet_testnet_faucet_limit (
  chain_id text NOT NULL,
  bucket text NOT NULL,
  subject text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL,
  PRIMARY KEY (chain_id, bucket, subject)
);
`;

function asSeq(value) {
  const seq = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("invalid durable transaction sequence");
  return seq;
}

function parseAccounts(value) {
  const record = value && typeof value === "object" ? value : null;
  const allocations = record?.allocations;
  const nonces = Array.isArray(record?.nonces) ? record.nonces : [];
  if (!Array.isArray(allocations)) throw new Error("invalid durable baseline");
  return { allocations, nonces };
}

export async function connectWalletTestnetDatabase(connectionString) {
  if (typeof connectionString !== "string" || connectionString.length < 12 || connectionString.length > 2_048) {
    throw new Error("ZYRON_TESTNET_DATABASE_URL is not a usable Postgres URL");
  }
  let Client;
  try {
    const loaded = await import("pg");
    Client = loaded.default?.Client ?? loaded.Client;
  } catch (error) {
    throw new Error(`pg driver unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Client) throw new Error("pg driver unavailable");
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: DURABLE_CONNECT_TIMEOUT_MS,
    query_timeout: DURABLE_QUERY_TIMEOUT_MS,
    statement_timeout: DURABLE_QUERY_TIMEOUT_MS,
    application_name: "zyron-wallet-testnet-rpc"
  });
  client.on("error", (error) => {
    console.warn(`wallet testnet database connection error: ${error instanceof Error ? error.message : String(error)}`);
  });
  await withTimeout(client.connect(), DURABLE_CONNECT_TIMEOUT_MS + 500, "database connect");
  let queue = Promise.resolve();
  const query = (sql, params = []) => {
    const run = queue.then(() => client.query(sql, params));
    queue = run.then(() => undefined, () => undefined);
    return run;
  };
  try {
    await withTimeout(query("SELECT 1"), DURABLE_QUERY_TIMEOUT_MS, "database ping");
    for (const statement of SCHEMA_SQL.split(";").map((part) => part.trim()).filter(Boolean)) {
      await query(statement);
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return {
    async load(chainId) {
      const baselineResult = await query(
        "SELECT compacted_through_seq, accounts FROM wallet_testnet_baseline WHERE chain_id = $1",
        [chainId]
      );
      let baseline = null;
      if (baselineResult.rows.length > 0) {
        const row = baselineResult.rows[0];
        const accounts = parseAccounts(row.accounts);
        baseline = { compactedThroughSeq: asSeq(row.compacted_through_seq), ...accounts };
      }
      const after = baseline ? baseline.compactedThroughSeq : 0;
      const txResult = await query(
        `SELECT seq, raw_tx FROM wallet_testnet_tx
         WHERE chain_id = $1 AND seq > $2
         ORDER BY seq ASC
         LIMIT $3`,
        [chainId, after, MAX_RESTORED_TRANSACTIONS + 1]
      );
      const entries = txResult.rows.map((row) => {
        const tx = row.raw_tx;
        if (!tx || typeof tx !== "object" || Array.isArray(tx)) throw new Error("stored transaction is not an object");
        return { seq: asSeq(row.seq), tx };
      });
      return { baseline, entries };
    },
    async insertIncluded(chainId, tx) {
      if (!tx || typeof tx.txid !== "string" || !/^[0-9a-f]{64}$/.test(tx.txid)) return;
      try {
        await query(
          `INSERT INTO wallet_testnet_tx (chain_id, raw_tx)
           SELECT $1, $2::jsonb
           WHERE NOT EXISTS (
             SELECT 1 FROM wallet_testnet_tx
             WHERE chain_id = $1 AND raw_tx->>'txid' = $3
           )`,
          [chainId, JSON.stringify(tx), tx.txid]
        );
      } catch (error) {
        if (error?.code === "23505") return;
        throw error;
      }
    },
    async saveBaseline(chainId, baseline) {
      validateAllocations(baseline.allocations, Number.MAX_SAFE_INTEGER);
      const seq = asSeq(baseline.compactedThroughSeq);
      await query(
        `INSERT INTO wallet_testnet_baseline (chain_id, compacted_through_seq, accounts)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (chain_id) DO UPDATE
           SET compacted_through_seq = EXCLUDED.compacted_through_seq,
               accounts = EXCLUDED.accounts,
               updated_at = now()`,
        [chainId, seq, JSON.stringify({ allocations: baseline.allocations, nonces: baseline.nonces ?? [] })]
      );
    },
    async loadFaucetLimits(chainId) {
      const result = await query(
        `SELECT bucket, subject,
                (EXTRACT(EPOCH FROM window_start) * 1000)::bigint AS window_start_ms,
                hits
         FROM wallet_testnet_faucet_limit
         WHERE chain_id = $1`,
        [chainId]
      );
      return result.rows.map((row) => ({
        bucket: row.bucket,
        subject: row.subject,
        windowStartMs: Number(row.window_start_ms),
        hits: Number(row.hits)
      }));
    },
    async saveFaucetLimit(chainId, bucket, subject, windowStartMs, hits) {
      if (typeof subject !== "string" || subject.length < 1 || subject.length > 200) return;
      if (!Number.isSafeInteger(windowStartMs) || !Number.isSafeInteger(hits) || hits < 0) return;
      await query(
        `INSERT INTO wallet_testnet_faucet_limit (chain_id, bucket, subject, window_start, hits)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5)
         ON CONFLICT (chain_id, bucket, subject) DO UPDATE
           SET window_start = EXCLUDED.window_start, hits = EXCLUDED.hits`,
        [chainId, bucket, subject, windowStartMs, hits]
      );
    },
    async deleteChain(chainId) {
      await query("DELETE FROM wallet_testnet_tx WHERE chain_id = $1", [chainId]);
      await query("DELETE FROM wallet_testnet_baseline WHERE chain_id = $1", [chainId]);
      await query("DELETE FROM wallet_testnet_faucet_limit WHERE chain_id = $1", [chainId]);
    },
    query,
    close: () => client.end()
  };
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
