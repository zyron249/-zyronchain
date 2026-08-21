# HTTP consensus response memory boundary

Configured HTTP peers are untrusted consensus inputs even when transport/authentication succeeds. The canonical `PeerClient` therefore shape-gates attestation and round-skip results while their decoded JSON memory lease is still held.

The inner result must contain only the fixed protocol fields. Public keys, signatures and hashes must have their canonical widths; validator addresses must correspond to the supplied public key; chain IDs and integer fields are bounded before the parsed graph can escape into `Promise.allSettled()`.

The route byte ceilings are deliberately sized for those fixed shapes rather than general block-sized responses: attestation replies are capped at **8 KiB** and round-skip replies at **16 KiB**. Declared `Content-Length` values above the route ceiling are rejected before body parsing, and streamed bodies are cancelled as soon as observed bytes cross the same bound. The existing aggregate HTTP-consensus wire/parse budgets remain in force as a second layer of protection across concurrent peers.

This is a memory/availability boundary, not consensus authentication. The existing later cryptographic signature checks, validator-set membership, chain/height/round/previous-hash checks and quorum/finality validation remain authoritative and unchanged.

The canonical HTTP consensus wrapper keeps the existing 8-second peer timeout and configured-peer count. Tightening these route ceilings does not alter consensus payload semantics, quorum rules, rewards, validator admission, or activation policy.

This hardening is not evidence of independent operators, public-testnet readiness, mainnet readiness, Sybil resistance or public-mining readiness. Existing activation gates remain fail-closed until their separate external evidence requirements are satisfied.
