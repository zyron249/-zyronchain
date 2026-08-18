# Authenticated peer nonce reservation

Peer request replay protection is fail-closed before request-body admission.

After identity, timestamp, target and signature validation succeeds in `PeerRequestAuthenticator.preflight()`, the `(nodeId, nonce)` tuple is reserved immediately. A second concurrent preflight carrying the same authenticated nonce is rejected as replay before body processing. Final `verify()` may consume only the matching reservation; after consumption, later use of the nonce is rejected as replay.

Abandoned reservations remain charged against both the global replay-cache bound and the authenticated peer's per-identity bound until the normal peer-request replay expiry window elapses. Live reservations are not evicted to admit new requests. This intentionally favors bounded fail-closed behavior over reclaiming capacity early from incomplete requests.

Direct callers that use `verify()` without a preceding preflight retain the existing behavior: a valid nonce is inserted directly as consumed after signature/body-hash verification and remains subject to the same global and per-identity limits.

This hardening does not change consensus, finality, mining rewards, public-network activation, or trusted-peer membership. It reduces the amount of repeated body/admission work a compromised trusted peer can cause with one valid signed nonce; it is not evidence of public-testnet or mainnet readiness.
