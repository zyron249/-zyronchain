# L1 block validation DoS boundary

ZyronChain enforces a canonical maximum serialized block size of **2,000,000 bytes**.

For untrusted proposal and finalized-block validation, block shape and bounded array cardinalities are checked first. The canonical JSON byte size is then checked **before** Merkle recomputation, proposer signature verification, round-skip certificate verification, or finality-attestation verification. Oversized blocks therefore fail closed before expensive consensus cryptography.

The chain layer retains its existing downstream byte checks as defense in depth. This hardening does not alter validator quorum rules, finality semantics, protocol activation, mining activation, or transaction validity.

Public-testnet and mainnet activation remain governed by the external evidence gates in `docs/l1-launch-authorization.json` and the readiness tracker; this control is only a resource-exhaustion boundary and is not launch evidence by itself.
