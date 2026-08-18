# Native P2P rate-limit overflow boundary

Native discovery, sync, consensus, checkpoint, and State-v2 protocols rate-limit authenticated Noise PeerIds with a fixed-size tracked-peer map. The map is never grown past its configured identity bound and live tracked peers are never evicted merely to admit a new identity.

When the tracked map is full, previously unseen PeerIds use one shared fixed-window overflow quota rather than receiving their own state entry. This keeps memory bounded while preventing a one-request-per-Sybil map fill from automatically denying every new legitimate PeerId. Once the shared overflow quota is exhausted, further untracked identities fail closed until that overflow window expires.

Overflow traffic cannot consume, reset, or evict the independent request window of an already tracked peer. Expired tracked entries are reclaimed only by the existing window-expiry logic, and the earliest-expiry sweep optimization remains intact. The shared overflow bucket stores no per-untracked-identity state.

This is a transport/admission DoS hardening boundary only. It does not change trusted-peer identity validation, consensus or finality semantics, mining/rewards, public-testnet/mainnet activation, or release-publication gates.
