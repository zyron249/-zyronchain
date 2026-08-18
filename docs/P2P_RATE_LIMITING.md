# Native P2P rate limiting

Status: pre-public-testnet security control. This document does not authorize public testnet, mainnet, public mining, or release publication.

Native discovery, sync, consensus, checkpoint, and state protocols key request-rate limits by authenticated Noise PeerId. The limiter keeps at most a fixed `maxTrackedPeers` map of individually tracked identities and never evicts a live tracked identity merely to admit a new one.

When the tracked map is full, a previously unseen PeerId is not granted its own fresh fixed-window quota. Instead, all untracked identities share one bounded overflow fixed-window quota. The overflow state has constant cardinality: one start timestamp and one counter, independent of the number of rotating PeerIds. Once that shared quota is exhausted, additional unseen identities fail closed until the overflow window expires. Existing tracked peers retain their independent quotas and are not charged against or reset by overflow traffic.

Tracked peer expiry continues to use the earliest-expiry sweep optimization. The overflow window resets only on its own deterministic fixed-window boundary; it does not trigger live-entry eviction or per-untracked-identity state growth.

This control reduces the ability of a Sybil operator to fill the tracked identity set and cheaply deny every subsequent legitimate new authenticated peer. It is an application-layer availability control, not Sybil resistance or evidence of independent failure domains. Real Internet adversarial testing and independent operators remain required before public-testnet activation.
