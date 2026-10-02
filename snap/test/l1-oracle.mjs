#!/usr/bin/env node
// Test-only oracle that runs ZyronChain's *real* l1 code (compiled l1/dist) so
// the Snap is checked against the canonical implementation rather than a copy.
//
// Protocol: one JSON request on stdin -> one JSON response on stdout.
// Build l1 first: `npm run l1:build` (from snap/).
//
// This file handles well-known TEST keys only (derived from public BIP-39 test
// mnemonics). It never touches real key material.
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const l1Dist = resolve(here, "../../l1/dist/src");
if (!existsSync(resolve(l1Dist, "transaction.js"))) {
  process.stderr.write(`l1 is not built (${l1Dist} missing). Run \`npm run l1:build\` in snap/ first.\n`);
  process.exit(2);
}
const load = (name) => import(pathToFileURL(resolve(l1Dist, name)).href);
const crypto = await load("crypto.js");
const transaction = await load("transaction.js");
const codec = await load("codec.js");
const types = await load("types.js");
const chainModule = await load("chain.js");

const TX_KINDS = ["transfer", "activity_settlement", "mining_claim", "validator_update", "protocol_upgrade"];

function readStdin() {
  return new Promise((resolveInput, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolveInput(data));
    process.stdin.on("error", reject);
  });
}

function result(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Builds a fresh single-validator l1 chain whose genesis funds `fundedAddress`,
 * optionally upgrades it to `protocolVersion` 3 (transaction version 2), then
 * runs mempool admission and full block production/acceptance for `tx`.
 */
function chainAccept({ tx, fundedAddress, fundingAtoms, chainId, protocolVersion }) {
  const validatorPrivate = "31".padStart(64, "0");
  const oraclePrivate = "32".padStart(64, "0");
  const poolPrivate = "33".padStart(64, "0");
  const validatorPublic = crypto.publicKeyFromPrivate(validatorPrivate);
  const validator = crypto.addressFromPublicKey(validatorPublic);
  const pool = crypto.addressFromPublicKey(crypto.publicKeyFromPrivate(poolPrivate));
  const genesisTime = 1_700_000_000_000;
  const genesis = {
    chainId,
    timestampMs: genesisTime,
    validators: [{ address: validator, publicKey: validatorPublic }],
    activityOracles: [crypto.publicKeyFromPrivate(oraclePrivate)],
    activityPool: pool,
    allocations: [{ address: fundedAddress, amountAtoms: fundingAtoms }]
  };
  const chain = new chainModule.ZyronChain(genesis);
  let clock = genesisTime;
  const accept = (txs) => {
    clock += 1_000;
    let block = chain.produceBlock(txs, validatorPrivate, { timestampMs: clock });
    block = chain.attestBlock(block, validatorPrivate);
    chain.acceptBlock(block, clock);
  };
  if (protocolVersion === 3) {
    const input = {
      chainId,
      nonce: 1,
      sender: validator,
      activationHeight: chainModule.MIN_PROTOCOL_UPDATE_DELAY + 1,
      protocolVersion: 3
    };
    const upgrade = transaction.createProtocolUpgrade({
      ...input,
      approvals: [transaction.createProtocolUpgradeApproval(input, validatorPrivate, validatorPublic)],
      timestampMs: genesisTime + 1
    }, validatorPrivate, validatorPublic);
    accept([upgrade]);
    while (chain.height + 1 < input.activationHeight) accept([]);
  }
  const protocolAtNext = chain.protocolVersionAt(chain.height + 1);
  const receiverBefore = chain.balance(tx.receiver);
  chain.validateMempoolAdmission(tx);
  accept([tx]);
  return {
    protocolVersion: protocolAtNext,
    height: chain.height,
    senderBalance: chain.balance(tx.sender),
    senderNonce: chain.nonce(tx.sender),
    receiverDelta: chain.balance(tx.receiver) - receiverBefore
  };
}

const request = JSON.parse(await readStdin());
let response;
switch (request.op) {
  case "address":
    response = result(() => {
      const publicKey = crypto.publicKeyFromPrivate(request.privateKey);
      return { publicKey, address: crypto.addressFromPublicKey(publicKey) };
    });
    break;
  case "createTransfer":
    response = result(() => {
      const publicKey = crypto.publicKeyFromPrivate(request.privateKey);
      return transaction.createTransfer(request.input, request.privateKey, publicKey, request.version);
    });
    break;
  case "validateTransaction":
    response = result(() => { transaction.validateTransactionShape(request.tx); return true; });
    break;
  case "chainAccept":
    response = result(() => chainAccept(request));
    break;
  case "verifyCanonicalDomain":
    response = result(() => crypto.verifyCanonicalDomain(request.domain, request.payload, request.signature, request.publicKey));
    break;
  case "verifyCanonical":
    response = result(() => crypto.verifyCanonical(request.payload, request.signature, request.publicKey));
    break;
  case "txid":
    response = result(() => codec.sha256Hex(codec.canonicalJson(request.payload)));
    break;
  case "constants":
    response = result(() => ({
      atomsPerZyn: types.ATOMS_PER_ZYN,
      maxSupplyAtoms: types.MAX_SUPPLY_ATOMS,
      transactionSigningDomains: TX_KINDS.map((kind) => transaction.transactionSigningDomain(kind))
    }));
    break;
  default:
    response = { ok: false, error: `unknown op ${request.op}` };
}
process.stdout.write(JSON.stringify(response));
