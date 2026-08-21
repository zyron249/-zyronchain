# Native consensus response memory boundary

Native consensus response frames remain under the global retained P2P frame-memory budget while their outer chain identity and route-specific result shape are validated.

Before the retained frame lease is released, peer-controlled `result` values are restricted to the exact bounded shape required by the request: one block attestation, one round-skip vote, `{ accepted: true }`, or one transaction id. Extra or nested fields are rejected. Public keys, signatures, previous block hashes and transaction ids must have their canonical fixed-width hexadecimal representation, and validator addresses must match the supplied public key.

This shape gate is a memory/admission boundary, not a replacement for consensus authentication. Block production still performs the existing signature, validator-set, chain, height, round, previous-hash and quorum validation before accepting attestations or skip votes.

Noise transport identity, chain/genesis identity checks, global frame byte/memory budgets, peer rate/inflight limits, consensus/finality rules, mining rules and launch-activation gates are unchanged. This repository regression evidence does not constitute public-testnet or mainnet readiness evidence.
