# HTTP consensus response memory boundary

Configured HTTP peers are untrusted consensus inputs even when transport/authentication succeeds. The canonical `PeerClient` therefore shape-gates attestation and round-skip results while their decoded JSON memory lease is still held.

The inner result must contain only the fixed protocol fields. Public keys, signatures and hashes must have their canonical widths; validator addresses must correspond to the supplied public key; chain IDs and integer fields are bounded before the parsed graph can escape into `Promise.allSettled()`.

This is a memory/availability boundary, not consensus authentication. The existing later cryptographic signature checks, validator-set membership, chain/height/round/previous-hash checks and quorum/finality validation remain authoritative and unchanged.

The canonical HTTP consensus wrapper keeps the existing 8-second peer timeout and configured-peer count. It also uses dedicated aggregate wire/parse budgets for these small consensus replies so a group of authenticated but misbehaving peers cannot retain arbitrary parsed graphs after returning parse capacity.

This hardening is not evidence of independent operators, public-testnet readiness, mainnet readiness, Sybil resistance or public-mining readiness. Existing activation gates remain fail-closed until their separate external evidence requirements are satisfied.
