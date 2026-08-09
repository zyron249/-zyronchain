import { assertHex, canonicalJson, sha256Hex } from "./codec.js";
import {
  addressFromPublicKey,
  signCanonical,
  signCanonicalDomain,
  verifyCanonical,
  verifyCanonicalDomain
} from "./crypto.js";
import { MAX_SUPPLY_ATOMS } from "./types.js";
import type {
  ActivityEntry,
  ActivitySettlementTx,
  Address,
  ProtocolUpgradeTx,
  Transaction,
  TransferTx,
  Validator,
  ValidatorApproval,
  ValidatorSetUpdateTx
} from "./types.js";

type UnsignedTransfer = Omit<TransferTx, "signature" | "txid">;
type UnsignedSettlement = Omit<ActivitySettlementTx, "signature" | "txid">;
type UnsignedValidatorUpdate = Omit<ValidatorSetUpdateTx, "signature" | "txid">;
type UnsignedProtocolUpgrade = Omit<ProtocolUpgradeTx, "signature" | "txid">;
export type TransactionVersion = 1 | 2;

const VALIDATOR_SET_APPROVAL_DOMAIN = "zyronchain/validator-set-approval/v1";
const PROTOCOL_UPGRADE_APPROVAL_DOMAIN = "zyronchain/protocol-upgrade-approval/v1";

function txSigningPayload(tx: Transaction | UnsignedTransfer | UnsignedSettlement | UnsignedValidatorUpdate | UnsignedProtocolUpgrade): unknown {
  const { signature: _signature, txid: _txid, ...payload } = tx as Transaction;
  return payload;
}

export function protocolUpgradeApprovalPayload(input: {
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  protocolVersion: number;
}): unknown {
  return {
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    activationHeight: input.activationHeight,
    protocolVersion: input.protocolVersion
  };
}

export function createProtocolUpgradeApproval(
  input: Parameters<typeof protocolUpgradeApprovalPayload>[0],
  validatorPrivateKey: string,
  validatorPublicKey: string,
  transactionVersion: TransactionVersion = 1
): ValidatorApproval {
  const payload = governanceApprovalPayload(protocolUpgradeApprovalPayload(input), transactionVersion);
  return {
    validator: addressFromPublicKey(validatorPublicKey),
    publicKey: validatorPublicKey,
    signature: signForTransactionVersion(
      transactionVersion,
      PROTOCOL_UPGRADE_APPROVAL_DOMAIN,
      payload,
      validatorPrivateKey
    )
  };
}

export function validatorUpdateApprovalPayload(input: {
  chainId: string;
  nonce: number;
  sender: Address;
  activationHeight: number;
  validators: Validator[];
}): unknown {
  return {
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    activationHeight: input.activationHeight,
    validators: input.validators
  };
}

export function createValidatorApproval(
  input: Parameters<typeof validatorUpdateApprovalPayload>[0],
  validatorPrivateKey: string,
  validatorPublicKey: string,
  transactionVersion: TransactionVersion = 1
): ValidatorApproval {
  const payload = governanceApprovalPayload(validatorUpdateApprovalPayload(input), transactionVersion);
  return {
    validator: addressFromPublicKey(validatorPublicKey),
    publicKey: validatorPublicKey,
    signature: signForTransactionVersion(
      transactionVersion,
      VALIDATOR_SET_APPROVAL_DOMAIN,
      payload,
      validatorPrivateKey
    )
  };
}

export function createValidatorSetUpdate(
  input: Omit<UnsignedValidatorUpdate, "kind" | "version" | "publicKey" | "feeAtoms">,
  privateKeyHex: string,
  publicKey: string,
  version: TransactionVersion = 1
): ValidatorSetUpdateTx {
  const unsigned: UnsignedValidatorUpdate = {
    kind: "validator_update",
    version,
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    activationHeight: input.activationHeight,
    validators: input.validators.map((validator) => ({ ...validator })),
    approvals: input.approvals.map((approval) => ({ ...approval })),
    feeAtoms: 0,
    timestampMs: input.timestampMs,
    publicKey
  };
  const signature = signTransactionPayload(unsigned, privateKeyHex);
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) };
}

export function createProtocolUpgrade(
  input: Omit<UnsignedProtocolUpgrade, "kind" | "version" | "publicKey" | "feeAtoms">,
  privateKeyHex: string,
  publicKey: string,
  version: TransactionVersion = 1
): ProtocolUpgradeTx {
  const unsigned: UnsignedProtocolUpgrade = {
    kind: "protocol_upgrade",
    version,
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    activationHeight: input.activationHeight,
    protocolVersion: input.protocolVersion,
    approvals: input.approvals.map((approval) => ({ ...approval })),
    feeAtoms: 0,
    timestampMs: input.timestampMs,
    publicKey
  };
  const signature = signTransactionPayload(unsigned, privateKeyHex);
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) };
}

function signedPayload(tx: Omit<Transaction, "txid">): unknown {
  const { txid: _txid, ...payload } = tx as Transaction;
  return payload;
}

export function createTransfer(
  input: Omit<UnsignedTransfer, "kind" | "version" | "publicKey">,
  privateKeyHex: string,
  publicKey: string,
  version: TransactionVersion = 1
): TransferTx {
  const unsigned: UnsignedTransfer = {
    kind: "transfer",
    version,
    chainId: input.chainId,
    nonce: input.nonce,
    sender: input.sender,
    receiver: input.receiver,
    amountAtoms: input.amountAtoms,
    feeAtoms: input.feeAtoms,
    timestampMs: input.timestampMs,
    publicKey
  };
  const signature = signTransactionPayload(unsigned, privateKeyHex);
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) };
}

export function createActivitySettlement(
  input: Omit<UnsignedSettlement, "kind" | "version" | "publicKey" | "feeAtoms">,
  privateKeyHex: string,
  publicKey: string,
  version: TransactionVersion = 1
): ActivitySettlementTx {
  const unsigned: UnsignedSettlement = {
    kind: "activity_settlement",
    version,
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
  const signature = signTransactionPayload(unsigned, privateKeyHex);
  const withSignature = { ...unsigned, signature };
  return { ...withSignature, txid: sha256Hex(canonicalJson(withSignature)) };
}

export function validateTransactionShape(value: unknown): asserts value is Transaction {
  assertPlainRecord(value, "transaction");
  if (value.kind === "transfer") {
    assertExactKeys(value, [
      "kind", "version", "chainId", "nonce", "sender", "receiver", "amountAtoms",
      "feeAtoms", "timestampMs", "publicKey", "signature", "txid"
    ], "transfer transaction");
  } else if (value.kind === "activity_settlement") {
    assertExactKeys(value, [
      "kind", "version", "chainId", "nonce", "sender", "epoch", "entries", "receiptRoot",
      "feeAtoms", "timestampMs", "publicKey", "signature", "txid"
    ], "activity settlement");
  } else if (value.kind === "validator_update") {
    assertExactKeys(value, [
      "kind", "version", "chainId", "nonce", "sender", "activationHeight", "validators", "approvals",
      "feeAtoms", "timestampMs", "publicKey", "signature", "txid"
    ], "validator update");
  } else if (value.kind === "protocol_upgrade") {
    assertExactKeys(value, [
      "kind", "version", "chainId", "nonce", "sender", "activationHeight", "protocolVersion", "approvals",
      "feeAtoms", "timestampMs", "publicKey", "signature", "txid"
    ], "protocol upgrade");
  } else {
    throw new Error("Unsupported transaction kind");
  }
  const tx = value as unknown as Transaction;
  if (tx.version !== 1 && tx.version !== 2) throw new Error("Unsupported transaction version");
  if (typeof tx.chainId !== "string") throw new Error("Invalid transaction chain ID");
  assertAddress(tx.sender);
  if (!Number.isSafeInteger(tx.nonce) || tx.nonce < 1) throw new Error("Invalid nonce");
  if (!Number.isSafeInteger(tx.timestampMs) || tx.timestampMs < 0) throw new Error("Invalid timestamp");
  if (typeof tx.publicKey !== "string" || typeof tx.signature !== "string" || typeof tx.txid !== "string") {
    throw new Error("Invalid transaction cryptographic fields");
  }
  assertHex(tx.publicKey, 64, "publicKey");
  assertHex(tx.signature, 64, "signature");
  assertHex(tx.txid, 32, "txid");

  if (tx.kind === "transfer") {
    assertAddress(tx.receiver);
    assertAmount(tx.amountAtoms, "amountAtoms", false);
    assertAmount(tx.feeAtoms, "feeAtoms", true);
    if (addressFromPublicKey(tx.publicKey) !== tx.sender) {
      throw new Error("Public key does not match sender");
    }
  } else if (tx.kind === "activity_settlement") {
    if (!Number.isSafeInteger(tx.epoch) || tx.epoch < 0) throw new Error("Invalid activity epoch");
    if (tx.feeAtoms !== 0) throw new Error("Activity settlement fee must be zero");
    assertHex(tx.receiptRoot, 32, "receiptRoot");
    if (!Array.isArray(tx.entries) || tx.entries.length === 0 || tx.entries.length > 10_000) {
      throw new Error("Invalid activity settlement size");
    }
    for (const entry of tx.entries) validateActivityEntry(entry);
  } else if (tx.kind === "validator_update") {
    if (tx.feeAtoms !== 0) throw new Error("Validator update fee must be zero");
    if (!Number.isSafeInteger(tx.activationHeight) || tx.activationHeight < 1) {
      throw new Error("Invalid validator activation height");
    }
    if (addressFromPublicKey(tx.publicKey) !== tx.sender) throw new Error("Public key does not match sender");
    if (!Array.isArray(tx.validators) || tx.validators.length === 0 || tx.validators.length > 100) {
      throw new Error("Invalid validator set size");
    }
    const validatorAddresses = new Set<string>();
    for (const validator of tx.validators) validateValidator(validator, validatorAddresses);
    if (!Array.isArray(tx.approvals) || tx.approvals.length === 0 || tx.approvals.length > 100) {
      throw new Error("Invalid validator approvals");
    }
    for (const approval of tx.approvals) validateValidatorApproval(approval);
  } else {
    if (tx.feeAtoms !== 0) throw new Error("Protocol upgrade fee must be zero");
    if (!Number.isSafeInteger(tx.activationHeight) || tx.activationHeight < 1) {
      throw new Error("Invalid protocol activation height");
    }
    if (!Number.isSafeInteger(tx.protocolVersion) || tx.protocolVersion < 1 || tx.protocolVersion > 65_535) {
      throw new Error("Invalid protocol version");
    }
    if (addressFromPublicKey(tx.publicKey) !== tx.sender) throw new Error("Public key does not match sender");
    if (!Array.isArray(tx.approvals) || tx.approvals.length === 0 || tx.approvals.length > 100) {
      throw new Error("Invalid protocol upgrade approvals");
    }
    for (const approval of tx.approvals) validateValidatorApproval(approval);
  }

  const expectedTxid = sha256Hex(canonicalJson(signedPayload(tx)));
  if (tx.txid !== expectedTxid) throw new Error("Transaction ID mismatch");
  if (!verifyTransactionSignature(tx)) {
    throw new Error("Invalid transaction signature");
  }
}

export function transactionSigningDomain(kind: Transaction["kind"]): string {
  switch (kind) {
    case "transfer": return "zyronchain/transaction/transfer/v2";
    case "activity_settlement": return "zyronchain/transaction/activity-settlement/v2";
    case "validator_update": return "zyronchain/transaction/validator-update/v2";
    case "protocol_upgrade": return "zyronchain/transaction/protocol-upgrade/v2";
  }
}

export function verifyValidatorUpdateApprovalSignature(tx: ValidatorSetUpdateTx, approval: ValidatorApproval): boolean {
  const payload = governanceApprovalPayload(validatorUpdateApprovalPayload(tx), tx.version);
  return verifyForTransactionVersion(
    tx.version,
    VALIDATOR_SET_APPROVAL_DOMAIN,
    payload,
    approval.signature,
    approval.publicKey
  );
}

export function verifyProtocolUpgradeApprovalSignature(tx: ProtocolUpgradeTx, approval: ValidatorApproval): boolean {
  const payload = governanceApprovalPayload(protocolUpgradeApprovalPayload(tx), tx.version);
  return verifyForTransactionVersion(
    tx.version,
    PROTOCOL_UPGRADE_APPROVAL_DOMAIN,
    payload,
    approval.signature,
    approval.publicKey
  );
}

function governanceApprovalPayload(payload: unknown, version: TransactionVersion): unknown {
  return version === 2 ? { transactionVersion: 2, payload } : payload;
}

function signTransactionPayload(tx: UnsignedTransfer | UnsignedSettlement | UnsignedValidatorUpdate | UnsignedProtocolUpgrade, privateKeyHex: string): string {
  return signForTransactionVersion(tx.version, transactionSigningDomain(tx.kind), tx, privateKeyHex);
}

function verifyTransactionSignature(tx: Transaction): boolean {
  return verifyForTransactionVersion(
    tx.version,
    transactionSigningDomain(tx.kind),
    txSigningPayload(tx),
    tx.signature,
    tx.publicKey
  );
}

function signForTransactionVersion(
  version: TransactionVersion,
  domain: string,
  payload: unknown,
  privateKeyHex: string
): string {
  return version === 2
    ? signCanonicalDomain(domain, payload, privateKeyHex)
    : signCanonical(payload, privateKeyHex);
}

function verifyForTransactionVersion(
  version: TransactionVersion,
  domain: string,
  payload: unknown,
  signatureHex: string,
  publicKeyHex: string
): boolean {
  return version === 2
    ? verifyCanonicalDomain(domain, payload, signatureHex, publicKeyHex)
    : verifyCanonical(payload, signatureHex, publicKeyHex);
}

function validateValidator(value: Validator, seen: Set<string>): void {
  assertPlainRecord(value, "validator");
  assertExactKeys(value, ["address", "publicKey"], "validator");
  assertAddress(value.address);
  if (typeof value.publicKey !== "string") throw new Error("Invalid validator public key");
  assertHex(value.publicKey, 64, "validator publicKey");
  if (addressFromPublicKey(value.publicKey) !== value.address) throw new Error("Validator address/public key mismatch");
  if (seen.has(value.address)) throw new Error("Duplicate validator");
  seen.add(value.address);
}

function validateValidatorApproval(value: ValidatorApproval): void {
  assertPlainRecord(value, "validator approval");
  assertExactKeys(value, ["validator", "publicKey", "signature"], "validator approval");
  assertAddress(value.validator);
  if (typeof value.publicKey !== "string" || typeof value.signature !== "string") throw new Error("Invalid validator approval");
  assertHex(value.publicKey, 64, "validator approval publicKey");
  assertHex(value.signature, 64, "validator approval signature");
  if (addressFromPublicKey(value.publicKey) !== value.validator) throw new Error("Validator approval address mismatch");
}

function validateActivityEntry(entry: ActivityEntry): void {
  assertPlainRecord(entry, "activity entry");
  assertExactKeys(entry, ["receiver", "amountAtoms"], "activity entry");
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
  if (typeof address !== "string" || !/^ZYN[0-9a-f]{40}$/.test(address)) {
    throw new Error("Invalid address");
  }
}

export function assertPlainRecord(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid ${name}`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`Invalid ${name} prototype`);
}

export function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  name: string
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid ${name} fields`);
  }
}
