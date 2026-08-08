import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import { addressFromPublicKey, signCanonical, verifyCanonical } from "./crypto.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";
import type {
  ActivityEntry,
  ActivitySettlementTx,
  Address,
  Transaction,
  TransferTx
} from "./types.js";

type UnsignedTransfer = Omit<TransferTx, "signature" | "txid">;
type UnsignedSettlement = Omit<ActivitySettlementTx, "signature" | "txid">;

function txSigningPayload(tx: Transaction | UnsignedTransfer | UnsignedSettlement): unknown {
  const { signature: _signature, txid: _txid, ...payload } = tx as Transaction;
  return payload;
}

function signedPayload(tx: Omit<Transaction, "txid">): unknown {
  const { txid: _txid, ...payload } = tx as Transaction;
  return payload;
}

export function createTransfer(
  input: Omit<UnsignedTransfer, "kind" | "version" | "publicKey">,
  privateKeyHex: string,
  publicKey: string
): TransferTx {
  const unsigned: UnsignedTransfer = {
    kind: "transfer",
    version: 1,
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    receiver: input.receiver,
    amountAtoms: input.amountAtoms,
    feeAtoms: input.feeAtoms,
    timestampMs: input.timestampMs,
    publicKey
  };
  const signature = signCanonical(unsigned, privateKeyHex);
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) };
}

export function createActivitySettlement(
  input: Omit<UnsignedSettlement, "kind" | "version" | "publicKey" | "feeAtoms">,
  privateKeyHex: string,
  publicKey: string
): ActivitySettlementTx {
  const unsigned: UnsignedSettlement = {
    kind: "activity_settlement",
    version: 1,
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    epoch: input.epoch,
    entries: input.entries.map((entry) => ({
      receiver: entry.receiver,
      amountAtoms: entry.amountAtoms
    })),
    receiptRoot: input.receiptRoot,
    feeAtoms: 0,
    timestampMs: input.timestampMs,
    publicKey
  };
  const signature = signCanonical(unsigned, privateKeyHex);
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) };
}

export function validateTransactionShape(tx: Transaction): void {
  if (tx.version !== 1) throw new Error("Unsupported transaction version");
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 1) throw new Error("Invalid nonce");
  if (!Number.isSafeInteger(tx.timestampMs) || tx.timestampMs < 0) throw new Error("Invalid timestamp");
  assertHex(tx.publicKey, 64, "publicKey");
  assertHex(tx.signature, 64, "signature");
  assertHex(tx.txid, 32, "txid");

  if (tx.kind === "transfer") {
    assertAmount(tx.amountAtoms, "amountAtoms", false);
    assertAmount(tx.feeAtoms, "feeAtoms", true);
    if (addressFromPublicKey(tx.publicKey) !== tx.sender) {
      throw new Error("Public key does not match sender");
    }
  } else {
    if (!Number.isSafeInteger(tx.epoch) || tx.epoch < 0) throw new Error("Invalid activity epoch");
    if (tx.feeAtoms !== 0) throw new Error("Activity settlement fee must be zero");
    assertHex(tx.receiptRoot, 32, "receiptRoot");
    if (tx.entries.length === 0 || tx.entries.length > 10_000) {
      throw new Error("Invalid activity settlement size");
    }
    for (const entry of tx.entries) validateActivityEntry(entry);
  }

  const expectedTxid = sha256Hex(canonicalJson(signedPayload(tx)));
  if (tx.txid !== expectedTxid) throw new Error("Transaction ID mismatch");
  if (!verifyCanonical(txSigningPayload(tx), tx.signature, tx.publicKey)) {
    throw new Error("Invalid transaction signature");
  }
}

function validateActivityEntry(entry: ActivityEntry): void {
  assertAddress(entry.receiver);
  assertAmount(entry.amountAtoms, "activity amount", false);
}

export function assertAmount(value: number, name: string, allowZero: boolean): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_SUPPLY_ATOMS) {
    throw new Error(`Invalid ${name}`);
  }
  if (!allowZero && value === 0) throw new Error(`${name} must be positive`);
}

export function assertAddress(address: string): asserts address is Address {
  if (!/^ZYN[0-9a-f]{40}$/.test(address)) throw new Error("Invalid address");
}
