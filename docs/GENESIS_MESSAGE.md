# Canonical genesis message

The reserved human-readable message for the eventual canonical public ZyronChain genesis is:

> Şîfre hat çêkirin, rê hat vekirin. Xatirê we.

The exact UTF-8/NFC bytes are recorded in `l1/genesis-message.json`. Their SHA-256 digest is:

`c458a9fd8d1fc11d5b0d19cda2b58fce4c689f5b458514d5a6891e6b993955f1`

This repository artifact is intentionally **not** a public-genesis activation. Current development/private-testnet genesis hashes remain unchanged. The manifest status must remain `reserved-for-public-genesis-freeze` until launch-readiness gates authorize a separately reviewed consensus change.

At final public-genesis freeze, the exact message bytes above must be cryptographically committed by the canonical genesis construction, with independent genesis/hash vectors updated and verified before any public mining, public testnet, or mainnet activation. No deployment or activation gate may be weakened to incorporate the message.

## CI custody boundary

The canonical message verifier runs on both Node 22 and Node 24. Its GitHub Actions checkout and Node setup actions are pinned to reviewed immutable commit SHAs, and checkout credential persistence is disabled. A dedicated fail-closed custody-policy check rejects mutable/drifted action refs, credential persistence, matrix weakening, or removal of the exact UTF-8 verifier. This protects the verification path only; it does not make the reserved message an activated genesis and does not satisfy any public-testnet, mining, or mainnet launch gate.
