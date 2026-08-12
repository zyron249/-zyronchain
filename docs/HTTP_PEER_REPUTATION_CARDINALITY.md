# HTTP peer reputation cardinality hardening

The legacy/HTTP peer reputation store persists at most 256 normalized peer endpoints. That bound is a memory/disk safety control, not proof of Sybil resistance or public-testnet readiness.

Previously, inserting a new endpoint after saturation evicted the oldest tracked endpoint. An attacker able to rotate advertised or configured endpoint identities could therefore displace an actively penalized endpoint and later reuse it without its backoff state.

The store now fails closed at saturation. An endpoint whose backoff is still active cannot be evicted merely to admit an unseen endpoint. When all 256 slots contain active penalties, unseen endpoints are unavailable. Capacity is reclaimed only from entries whose backoff has expired, using deterministic oldest-activity ordering with endpoint tie-breaking. This preserves bounded durable state while preventing endpoint churn from resetting active penalties.

This control complements native P2P admission, authenticated peer identity, connection and request budgets, peer-pool caps and topology diversity checks. It does not satisfy the independent-operator, independent-audit, sustained-Internet-soak, production signer-custody or target-hardware evidence gates tracked in issues #249, #260 and #261.

Regression coverage verifies rotation resistance, the 256-entry durable bound, restart persistence and capacity recovery after penalty expiry.
