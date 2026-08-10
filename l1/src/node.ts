export * from "./node-base.js";

import {
  BLOCK_INTERVAL_MS,
  ROUND_WINDOW_MS,
  NodeService,
  type ConsensusPeerClient
} from "./node-base.js";
import {
  expectedValidator,
  validateBlockAttestation,
  validateRoundSkipQuorum,
  validateRoundSkipVote
} from "./block.js";
import type { Address, Block, BlockAttestation, RoundSkipVote } from "./types.js";
import { LocalValidatorSigner, type ValidatorSigner } from "./validator-signer.js";

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Production-safe block production clock handling.
 *
 * The block/round decision is anchored to one consensus timestamp so the
 * proposal timestamp cannot drift while peer I/O is in flight. Local signing
 * operations, however, use a fresh wall-clock sample in production. This
 * prevents a concurrent inbound signing request from advancing the same
 * NodeService clock watermark and making an older captured proposal timestamp
 * look like a physical clock rollback.
 *
 * Tests that explicitly inject `nowMs` retain the historical deterministic
 * fixed-clock behavior.
 */
export async function produceFinalizedBlock(
  service: NodeService,
  peers: ConsensusPeerClient,
  validator: string | ValidatorSigner,
  nowMs?: number
): Promise<Block | null> {
  const fixedClock = nowMs !== undefined;
  const consensusNowMs = nowMs ?? Date.now();
  const signingNowMs = (): number => fixedClock ? consensusNowMs : Date.now();
  const chain = service.store.chain;
  const elapsed = consensusNowMs - chain.tip.header.timestampMs;
  if (elapsed < BLOCK_INTERVAL_MS) return null;
  const round = Math.max(0, Math.floor((elapsed - BLOCK_INTERVAL_MS) / ROUND_WINDOW_MS));
  const signer = typeof validator === "string" ? new LocalValidatorSigner(validator) : validator;
  const publicKey = signer.publicKey;
  const validators = chain.validatorsAt(chain.height + 1);
  const expected = expectedValidator(validators, chain.height + 1, round);
  if (expected.publicKey !== publicKey) return null;

  let roundCertificate: RoundSkipVote[] = [];
  if (round > 0) {
    let previousCertificate: RoundSkipVote[] = [];
    for (let skippedRound = 0; skippedRound < round; skippedRound += 1) {
      const votes: RoundSkipVote[] = [];
      try {
        votes.push(await service.requestSkipVote(
          chain.height + 1,
          skippedRound,
          previousCertificate,
          signingNowMs()
        ));
      } catch {
        // An honest validator that already attested this round must never also skip it.
      }
      votes.push(...await peers.requestRoundSkips(chain.height + 1, skippedRound, previousCertificate));
      const unique = new Map<Address, RoundSkipVote>();
      for (const vote of votes) {
        try {
          validateRoundSkipVote(
            vote,
            validators,
            chain.genesis.chainId,
            chain.height + 1,
            skippedRound,
            chain.tip.hash
          );
          unique.set(vote.validator, vote);
        } catch {
          // A malformed or invalid peer vote cannot poison an otherwise valid quorum.
        }
      }
      const certificate = [...unique.values()];
      try {
        validateRoundSkipQuorum(
          certificate,
          validators,
          chain.genesis.chainId,
          chain.height + 1,
          skippedRound,
          chain.tip.hash
        );
      } catch {
        return null;
      }
      roundCertificate = certificate;
      previousCertificate = certificate;
    }
  }

  const transactions = chain.selectValidPending(service.mempool.values(), 10_000);
  const unsignedProposal = chain.prepareBlock(transactions, publicKey, {
    round,
    timestampMs: consensusNowMs,
    roundCertificate
  });
  const proposal = await service.signPreparedProposal(unsignedProposal, signingNowMs());
  chain.validatePreparedBlock(proposal, consensusNowMs);

  const attestations: BlockAttestation[] = [];
  try {
    attestations.push(await service.attestProposal(proposal, signingNowMs()));
  } catch (error) {
    if (!/Validator signing is disabled/.test(safeError(error))) throw error;
  }
  attestations.push(...await peers.requestAttestations(proposal));

  const byValidator = new Map<Address, BlockAttestation>();
  for (const attestation of attestations) {
    try {
      validateBlockAttestation(proposal, attestation, validators);
      byValidator.set(attestation.validator, attestation);
    } catch {
      // Invalid peer attestations are ignored instead of poisoning block assembly.
    }
  }
  const withVotes = { ...proposal, attestations: [...byValidator.values()] };
  try {
    await service.acceptFinalizedBlock(withVotes);
  } catch (error) {
    if (/Finality quorum not reached/.test(safeError(error))) return null;
    throw error;
  }
  await peers.broadcastBlock(withVotes);
  return withVotes;
}
