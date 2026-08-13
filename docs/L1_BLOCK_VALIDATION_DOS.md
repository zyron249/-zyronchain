# L1 block validation DoS boundary

ZyronChain enforces a canonical maximum serialized block size of **2,000,000 bytes**.

For untrusted proposal and finalized-block validation, the validator first checks the exact outer block/header schema, required array types, and protocol-wide transaction/certificate cardinality bounds. It then checks the canonical JSON byte size **before** per-transaction txid/signature verification, nested transaction validation, certificate-entry validation, Merkle recomputation, proposer signature verification, round-skip verification, or finality-attestation verification. Oversized but count-valid blocks therefore fail closed before attacker-amplifiable consensus cryptography.

After the byte boundary passes, the complete `validateBlockShape()` rules still validate every transaction and certificate entry. The chain layer also retains downstream byte checks as defense in depth. This hardening does not alter exact-key schemas, transaction validity, validator quorum rules, finality semantics, protocol activation, mining activation, or transaction economics.

The existing oversized-block regression exercises the canonical 2 MiB boundary through the shared block-shape/envelope path. Public-testnet and mainnet activation remain governed by the external evidence gates in `docs/l1-launch-authorization.json` and the readiness tracker; this control is only a resource-exhaustion boundary and is not launch evidence by itself.
