# Native State-v2 response frame bounds

The native State-v2 transfer protocol uses request-kind-specific response ceilings so small key-preimage chunks cannot reserve the much larger memory budget required by record chunks.

- `manifest`: 2,500,000 bytes. This preserves the existing bound because the manifest carries the finalized tip block.
- `records`: 20 MiB. This preserves the existing bound for up to 128 node records, including leaf records whose canonical `valueJson` can be as large as 64 KiB before outer JSON escaping.
- `keys`: 2 MiB. A key chunk is limited to 1,024 preimages, and portable-state validation limits each preimage to 256 JavaScript characters. The 2 MiB ceiling remains above the worst-case outer-JSON escaping envelope while materially reducing frame-budget reservation pressure.

The same `stateResponseMaxBytes()` helper is used for server response writes and client response reads. This keeps wire admission symmetric and prevents one side from silently retaining the former 20 MiB key-chunk allowance.

These bounds do not change checkpoint trust. State transfer still requires authenticated Noise, an externally supplied exact tip/snapshot digest anchor, exact response shapes, bounded retries, retained decoded-frame custody, and full State-v2 reconstruction/validation before imported state is trusted.

This is availability/resource hardening only. It is not evidence that public mining, a public testnet, or mainnet activation is ready, and it does not weaken any activation, finality, signing, recovery, or release gate.
