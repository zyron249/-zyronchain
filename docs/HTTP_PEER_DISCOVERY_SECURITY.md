# HTTP peer discovery admission security

The HTTP peer directory remains globally fail-closed at 256 live signed records, and each discovery response remains bounded to 32 records.

Remote discovery is additionally attributed to the normalized configured source URL. A single configured source may own at most one response budget of live directory records (32 by default, or a lower configured response/global limit). Live records are never evicted merely to admit a new identity from that source.

A newer valid record for an already admitted node identity may refresh the existing record without consuming another source slot. Source attribution is retained until the signed record expires; expiry releases both global directory capacity and the corresponding source slot deterministically.

Direct/operator-owned `PeerDirectory.admit()` calls omit a remote source and therefore are not charged to a remote discovery source quota. The global directory limit still applies to every admission.

This control reduces availability and eclipse pressure from a malicious or compromised configured discovery source. It is not Sybil resistance, independent-operator evidence, or public-testnet/mainnet readiness evidence. Activation gates remain independent and fail closed.
