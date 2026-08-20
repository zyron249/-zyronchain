# P2P checkpoint resource bounds

The native checkpoint protocol is transport for an externally authenticated checkpoint anchor; a peer response is never a trust source.

Checkpoint snapshots are limited to 64 MiB and transferred in bounded chunks. On the serving side, the canonical local snapshot is materialized at most once per finalized tip while retained in the two-tip cache. The canonical candidate is cached independently of the requester-supplied digest, so repeated requests with an incorrect digest cannot force repeated full serialization of the same finalized tip. The supplied digest is still required to match before any checkpoint bytes are served.

On the client side, the first authenticated/validated response fixes the bounded `totalBytes` value. The receiver allocates one destination buffer of that exact size and copies each canonical base64-decoded chunk directly into the validated offset. It does not retain a second `Buffer[]` copy of the full transfer and does not call `Buffer.concat` after download completion. Metadata drift, offset mismatch, oversized chunks, incomplete transfers and digest mismatch remain fail-closed.

This removes one avoidable full binary duplication during recovery, but the legacy checkpoint path still materializes a UTF-8 string and parsed snapshot object for canonical JSON and trusted-snapshot validation. Therefore this is resource hardening, not target-hardware recovery evidence, and it does not close the State-v2 capacity/recovery STOP-SHIP gate tracked by #383.

These controls do not weaken chain/genesis identity checks, the externally supplied tip/digest anchor, finality validation, State-v2 validation, or any public-mining/public-testnet/mainnet activation gate.
