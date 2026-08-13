# P2P checkpoint resource bounds

The native checkpoint protocol is transport for an externally authenticated checkpoint anchor; a peer response is never a trust source.

Checkpoint snapshots are limited to 64 MiB and transferred in bounded chunks. On the serving side, the canonical local snapshot is materialized at most once per finalized tip while retained in the two-tip cache. The canonical candidate is cached independently of the requester-supplied digest, so repeated requests with an incorrect digest cannot force repeated full serialization of the same finalized tip. The supplied digest is still required to match before any checkpoint bytes are served.

This cache is an availability/resource control only. It does not weaken chain/genesis identity checks, the externally supplied tip/digest anchor, finality validation, State-v2 validation, or any public-testnet/mainnet activation gate.
