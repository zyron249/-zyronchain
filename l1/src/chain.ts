import { canonicalJson } from "./codec.js";
import {
  createGenesisBlock,
  createBlockAttestation,
  createSignedBlock,
  expectedValidator,
  validateBlockEnvelope
} from "./block.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "./crypto.js";
import { LedgerState } from "./state.js";
import { validateTransactionShape } from "./transaction.js";
import type { Block, GenesisConfig, Transaction } from "./types.js";

const MAX_BLOCK_BYTES = 2_000_000;

export class ZyronChain {
  readonly genesis: GenesisConfig;
  private readonly blocks: Block[];
  private state: LedgerState;

  constructor(genesis: GenesisConfig) {
    validateGenesis(genesis);
    this.genesis = structuredClone(genesis);
    this.state = LedgerState.fromGenesis(genesis);
    this.blocks = [createGenesisBlock(genesis, this.state.root())];
  }

  get height(): number {
    return this.blocks.length - 1;
  }

  get tip(): Block {
    return this.blocks[this.blocks.length - 1]!;
  }

  getState(): LedgerState {
    return this.state.clone();
  }

  getBlocks(): readonly Block[] {
    return this.blocks;
  }

  attestBlock(block: Block, validatorPrivateKey: string): Block {
    const publicKey = publicKeyFromPrivate(validatorPrivateKey);
    const validator = this.genesis.validators.find((item) => item.publicKey === publicKey);
    if (!validator) throw new Error("Attestor is not in validator set");
    if (block.attestations.some((item) => item.validator === validator.address)) {
      throw new Error("Validator already attested block");
    }
    const copy = structuredClone(block);
    copy.attestations.push(createBlockAttestation(block, validatorPrivateKey, publicKey));
    return copy;
  }

  produceBlock(
    transactions: Transaction[],
    proposerPrivateKey: string,
    options: { round?: number; timestampMs?: number } = {}
  ): Block {
    const round = options.round ?? 0;
    const publicKey = publicKeyFromPrivate(proposerPrivateKey);
    const expected = expectedValidator(this.genesis.validators, this.height + 1, round);
    if (publicKey !== expected.publicKey || addressFromPublicKey(publicKey) !== expected.address) {
      throw new Error("Private key is not the expected proposer");
    }
    const timestampMs = options.timestampMs ?? Math.max(Date.now(), this.tip.header.timestampMs + 1);
    const nextState = this.validateAndApply(transactions, this.state);
    return createSignedBlock({
      chainId: this.genesis.chainId,
      height: this.height + 1,
      round,
      previousHash: this.tip.hash,
      timestampMs,
      transactions,
      stateRoot: nextState.root(),
      proposerPrivateKey,
      proposerPublicKey: publicKey
    });
  }

  acceptBlock(block: Block, nowMs = Date.now()): void {
    validateBlockEnvelope(block, this.tip, this.genesis.validators, nowMs);
    if (canonicalJson(block).length > MAX_BLOCK_BYTES) throw new Error("Block exceeds byte limit");
    const nextState = this.validateAndApply(block.transactions, this.state);
    if (block.header.stateRoot !== nextState.root()) throw new Error("State root mismatch");
    this.blocks.push(structuredClone(block));
    this.state = nextState;
  }

  private validateAndApply(transactions: Transaction[], startingState: LedgerState): LedgerState {
    const next = startingState.clone();
    const seen = new Set<string>();
    for (const tx of transactions) {
      if (tx.chainId !== this.genesis.chainId) throw new Error("Wrong transaction chain ID");
      if (seen.has(tx.txid)) throw new Error("Duplicate transaction in block");
      seen.add(tx.txid);
      validateTransactionShape(tx);
      if (tx.kind === "activity_settlement") {
        if (!this.genesis.activityOracles.includes(tx.publicKey)) {
          throw new Error("Unauthorized activity oracle");
        }
      }
      next.apply(tx, this.genesis.activityPool);
    }
    return next;
  }
}

function validateGenesis(genesis: GenesisConfig): void {
  if (!/^[a-z0-9-]{3,64}$/.test(genesis.chainId)) throw new Error("Invalid chain ID");
  if (!Number.isSafeInteger(genesis.timestampMs) || genesis.timestampMs < 0) {
    throw new Error("Invalid genesis timestamp");
  }
  if (genesis.validators.length === 0) throw new Error("At least one validator is required");
  const validators = new Set<string>();
  for (const validator of genesis.validators) {
    if (addressFromPublicKey(validator.publicKey) !== validator.address) {
      throw new Error("Validator address/public key mismatch");
    }
    if (validators.has(validator.address)) throw new Error("Duplicate validator");
    validators.add(validator.address);
  }
  if (!genesis.activityOracles.length) throw new Error("At least one activity oracle is required");
}
