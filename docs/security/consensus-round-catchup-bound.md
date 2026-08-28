# Consensus round catch-up containment

Validator production derives a consensus round from the elapsed wall-clock time since the local chain tip. To prevent a forward clock fault or unexpectedly stale local tip from turning a single production attempt into unbounded sequential skip-certificate work, `produceFinalizedBlock()` rejects derived rounds above `MAX_CONSENSUS_ROUND_CATCHUP` before any skip-vote signing or peer round-skip request begins.

The bound is intentionally fail-closed. The validator does not clamp to a different round or proposer, and it does not sign a block, attestation, or skip vote for an unsupported catch-up distance. Ordinary bounded round catch-up continues to use the existing deterministic proposer selection, predecessor-certificate chain, quorum validation, and signing-journal anti-equivocation rules.

This control contains local clock/staleness faults and resource amplification. It is not evidence that public mining, public testnet, or mainnet activation criteria have been met. Existing readiness and activation gates remain authoritative.