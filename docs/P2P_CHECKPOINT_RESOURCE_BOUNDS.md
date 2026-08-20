# P2P checkpoint resource bounds

The native checkpoint protocol is transport for an externally authenticated checkpoint anchor; a peer response is never a trust source.

Checkpoint snapshots are limited to 64 MiB and transferred in bounded chunks. On the serving side, the canonical local snapshot is materialized at most once per finalized tip while retained in the two-tip cache. The canonical candidate is cached independently of the requester-supplied digest, so repeated requests with an incorrect digest cannot force repeated full serialization of the same finalized tip. The supplied digest is still required to match before any checkpoint bytes are served.

On the client side, the first authenticated/validated response fixes the bounded `totalBytes` value. The receiver allocates one destination buffer of that exact size and copies each canonical base64-decoded chunk directly into the validated offset. It does not retain a second `Buffer[]` copy of the full transfer and does not call `Buffer.concat` after download completion. Metadata drift, offset mismatch, oversized chunks, incomplete transfers and digest mismatch remain fail-closed.

After download completion the receiver authenticates the exact byte buffer against the externally supplied snapshot SHA-256 before UTF-8 conversion. Once the UTF-8 representation exists, the completed binary buffer reference is released before JSON parsing. After parsing, the original full UTF-8 string reference is released before canonical re-serialization; canonical equivalence is checked by matching the canonical serialization byte length and SHA-256 back to the same external anchor. This avoids retaining the binary buffer while parsing and avoids retaining both the original and canonical full strings at the same time.

The parsed snapshot object still overlaps the canonical serialization needed for canonical-JSON verification, and trusted-snapshot reconstruction can itself require substantial target-scale memory. These controls therefore reduce transient recovery peak memory but do **not** constitute target-hardware capacity evidence and do not close the State-v2 capacity/recovery STOP-SHIP gate tracked by #383.

These controls do not weaken chain/genesis identity checks, the externally supplied tip/digest anchor, finality validation, State-v2 validation, or any public-mining/public-testnet/mainnet activation gate.
