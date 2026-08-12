# Native node identity durability

The native node identity is a persistent secp256k1 identity used to bind trusted-peer authentication, peer records and libp2p chain identity across restarts. It is operational identity material, not a validator signing key and not a substitute for production HSM or remote-signer custody.

First creation now uses exclusive file creation with mode `0600`, writes the canonical identity, fsyncs the file, closes it, and fsyncs the containing data directory before returning the new identity to the node. Concurrent creators retain the existing fail-safe behavior: only one exclusive create wins and the others load and validate that winner.

If an interrupted write leaves a present but malformed/inconsistent identity file, startup fails closed through the existing parser/key-consistency checks. The node does not delete that state and silently rotate to a new identity. Operators should recover the intended identity from protected backup or deliberately re-establish trust rather than treating accidental identity rotation as recovery.

This durability barrier improves identity continuity under sudden process/host failure. It does not prove storage hardware durability, does not provide encrypted/HSM custody for the node-identity private key, and does not satisfy the external production signer/audit/independent-operator evidence gates tracked by the readiness process.
