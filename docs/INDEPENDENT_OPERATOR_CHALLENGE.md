# ZyronChain independent-operator challenge

Status: **challenge preparation only**. This does not prove independent operation and does not authorize a public testnet or mainnet.

## Objective

A founder-independent network needs evidence from people or organizations that are not controlled by the founder and can operate from public artifacts without private instructions. Internal CI cannot manufacture that independence. This challenge defines the public procedure and evidence format that an external operator can execute when a candidate testnet release and independently reachable bootstrap/checkpoint infrastructure exist.

## Operator procedure

An external operator should:

1. obtain the published L1 release artifact without a private source checkout or founder-supplied binary;
2. verify published SHA-256 checksums, runtime SBOM and release provenance/attestation;
3. generate node/validator/wallet keys locally as appropriate and never send private keys or signer tokens to project maintainers;
4. obtain the candidate testnet chain/genesis identity and checkpoint anchors through independently authenticated public channels rather than trusting the serving peer alone;
5. configure at least two authenticated bootstrap peers from at least two genuinely independent failure domains when the candidate topology exposes them;
6. synchronize a clean node, record the finalized height/tip, stop it cleanly, restart from the same local state and prove exact chain identity/tip recovery;
7. execute the documented checkpoint restore rehearsal when an independently anchored checkpoint is available;
8. produce the machine-readable evidence expected by `l1/scripts/verify-independent-operator-evidence.mjs` without including private IP addresses, private keys, credentials or unrelated personal data;
9. publish the evidence for independent review.

For validator participation, admission must follow the public validator-governance process. A founder must never satisfy the challenge by handing the operator an existing validator private key.

## Evidence does not prove independence by itself

The verifier checks format and internal consistency only. A self-declared failure-domain label or `founderPrivateAssistanceUsed: false` field is not cryptographic proof of real-world independence. The verifier therefore always emits `independenceProven: false` and `externalReviewRequired: true`.

External reviewers must determine whether the operator, infrastructure, credentials and failure domains are actually independent. Multiple accounts, services or regions controlled by one person or one provider must not be counted as independent merely because their labels differ.

## CI test-vector mode

Required CI uses a clearly marked synthetic test vector solely to prove the verifier accepts a structurally valid record and rejects contradictory evidence such as `founderPrivateAssistanceUsed: true`. Synthetic CI evidence must never be submitted as an executed operator challenge.

## Launch boundary

The challenge can be prepared in advance, but the external gate remains open until genuinely independent operators execute it against a real candidate network and the evidence is reviewed. `publicTestnetAuthorized` and `mainnetAuthorized` remain false in the repository policy until the broader readiness process explicitly changes them.
