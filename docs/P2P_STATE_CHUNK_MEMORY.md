# State-v2 P2P chunk memory boundary

State-v2 chunk responses are decoded by `readP2PFrameRetained()`, which holds the encoded and decoded frame reservations until the caller explicitly releases them. The chunk parser therefore validates and returns the same decoded `items` graph instead of cloning the full array while the retained-frame reservation is still held.

For resumable transfers, the reservation remains held through `PortableStateResumeStore.putRecords()` / `putKeys()` so the validated chunk is persisted before release. For the in-memory compatibility path, the validated item references are consumed into the aggregate bundle before release. Exact response fields, authenticated Noise peer identity, chain identity, external anchor, chunk start/length, poison discard and peer failover semantics remain unchanged.

This change removes one transient full-chunk heap amplification. It is not target-hardware capacity evidence and does not close the State-v2 recovery peak-memory stop-ship tracked by issue #383. Public-testnet or mainnet readiness still requires the separate real-hardware evidence and activation gates.
