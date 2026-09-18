import assert from "node:assert/strict";
import test from "node:test";

import { createBlockAttestation, createRoundSkipVote, expectedValidator,
  validateAttestationQuorum, validateRoundSkipQuorum, validatorQuorumSize } from "../src/block.js";
import { ZyronChain } from "../src/chain.js";
import { addressFromPublicKey, publicKeyFromPrivate } from "../src/crypto.js";

// Characterization of an OPEN liveness defect, not evidence of recovery.
// This model uses real proposal/signature/certificate validation but does not
// model transport or disk durability. The journal's exclusive first-choice
// rule makes the two signer sets below disjoint for the lifetime of the slot.
for (const count of [2, 4, 7]) {
  test(`known liveness counterexample: ${count} honest validators split attest/skip`, () => {
    // Public, deterministic test-only keys. Never fund these identities.
    const keys = Array.from({ length: count }, (_, index) => (index + 1).toString(16).padStart(64, "0"));
    const validators = keys.map(key => {
      const publicKey = publicKeyFromPrivate(key);
      return { address: addressFromPublicKey(publicKey), publicKey };
    });
    const chain = new ZyronChain({
      chainId: `zyron-split-vote-model-${count}`, timestampMs: 1_700_000_000_000,
      validators, activityOracles: [validators[0]!.publicKey],
      activityPool: validators[0]!.address,
      allocations: [{ address: validators[0]!.address, amountAtoms: 1_000_000 }]
    });
    const proposer = expectedValidator(validators, 1, 0);
    const proposerIndex = validators.findIndex(v => v.publicKey === proposer.publicKey);
    const order = [proposerIndex, ...keys.map((_, i) => i).filter(i => i !== proposerIndex)];
    const split = Math.floor(count / 2);
    const attesters = order.slice(0, split);
    const skippers = order.slice(split);
    const time = chain.tip.header.timestampMs + 30_000;
    const proposal = chain.produceBlock([], keys[proposerIndex]!, { timestampMs: time });
    chain.validateProposal(proposal, time);
    proposal.attestations = attesters.map(i => createBlockAttestation(proposal, keys[i]!, validators[i]!.publicKey));
    const skipVote = (i: number) => createRoundSkipVote({
      chainId: chain.genesis.chainId, height: 1, round: 0, previousHash: chain.tip.hash,
      validatorPrivateKey: keys[i]!, validatorPublicKey: validators[i]!.publicKey,
      protocolVersion: proposal.header.version
    });
    const skipVotes = skippers.map(skipVote);
    const validateSkips = (votes: typeof skipVotes) => validateRoundSkipQuorum(votes,
      validators, chain.genesis.chainId, 1, 0, chain.tip.hash, proposal.header.version);

    assert.equal(new Set([...attesters, ...skippers]).size, count);
    assert.ok(attesters.length < validatorQuorumSize(count));
    assert.ok(skippers.length < validatorQuorumSize(count));
    assert.throws(() => validateAttestationQuorum(proposal, validators), /Finality quorum not reached/);
    assert.throws(() => validateSkips(skipVotes), /Round skip quorum not reached/);

    // Merely delivering all already-signed messages cannot create a quorum.
    // Replays cannot be counted as additional validators.
    assert.throws(() => validateAttestationQuorum({ ...proposal,
      attestations: [...proposal.attestations, proposal.attestations[0]!] }, validators), /Duplicate validator attestation/);
    assert.throws(() => validateSkips([...skipVotes, skipVotes[0]!]), /Duplicate round skip vote/);

    // Control fixtures in DIFFERENT hypothetical voting histories: both
    // certificate validators accept a genuine quorum. These extra votes must
    // never be requested from the locked signers in the split history above.
    const quorum = validatorQuorumSize(count);
    assert.doesNotThrow(() => validateAttestationQuorum({ ...proposal,
      attestations: order.slice(0, quorum).map(i => createBlockAttestation(proposal, keys[i]!, validators[i]!.publicKey))
    }, validators));
    assert.doesNotThrow(() => validateSkips(order.slice(0, quorum).map(skipVote)));
  });
}
