# Consensus certificate model

Status: executable bounded safety model for the standalone L1.

## Scope

The model in `l1/test/consensus-certificate-model.test.ts` exhaustively enumerates validator certificate sets and Byzantine fault sets for validator counts 1 through 10. Larger-set quorum arithmetic is covered by `consensus-properties.test.ts`.

It checks the certificate-level argument behind certified view changes:

1. finality and governance use `floor(2N/3)+1` signatures;
2. at most `floor((N-1)/3)` validators are Byzantine;
3. every pair of valid certificates intersects in at least one honest validator;
4. an honest validator's durable journal cannot attest and skip the same `(height, round)`;
5. reaching a later round requires the immediately preceding skip certificate;
6. therefore a finalized value prevents the first skip needed to reach a conflicting later-round proposal.

The model separately checks conflicting finality certificates and the finality-versus-progress certificate pair.

## Mutation sensitivity

A safety checker that only passes the intended rule can be accidentally tautological. The suite therefore mutates quorum to non-strict `ceil(2N/3)` and requires the checker to find the three-validator counterexample:

- certificate one: validators A+B;
- certificate two: validators B+C;
- Byzantine set: validator B;
- honest intersection: empty.

The production `validatorQuorumSize(3)` must remain 3.

## Relationship to implementation tests

This model does not replace implementation testing. The main suite separately exercises:

- fsynced journal persistence and conflicting-action rejection;
- sequential round-skip validation;
- scheduled proposer enforcement;
- four-validator repeated proposer failure;
- 2/2 partition safety and 3/1 recovery;
- crash/restart, checkpoint and rollback paths;
- protocol and validator-set activation.

## Limits

This is a bounded executable model, not a machine-checked proof of the complete network implementation. It assumes the signature scheme, validator identity uniqueness, journal durability and exact certificate validation work as specified. Public-testnet readiness still requires fault-injection across real multi-process nodes and independent review of the synchrony/liveness assumptions.
