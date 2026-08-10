# Render validator clock fail-stop supervision

Status: private/adversarial rehearsal only. This does not authorize a public testnet or mainnet.

The canonical validator signer deliberately fails closed if its local wall clock moves backwards by more than the configured safety tolerance. A faulted `NodeService` reports `validator-clock-unhealthy` and will not sign again until process restart. This safety behavior is not weakened to improve liveness: the one-second rollback tolerance, anti-equivocation signing journal and consensus rules remain unchanged.

The single-instance Render rehearsal places all four validator processes in one host/clock failure domain. It therefore cannot provide independent-operator or independent-clock evidence. Live evidence on 2026-08-10 showed one validator entering the clock fail-stop while the public gateway process remained alive and finality stopped. A separate stale-signing-time bug that could falsely trigger this condition was fixed in PR #229; genuine clock fail-stop recovery remains an operational concern.

## Supervised recovery model

`render-clock-failstop-supervisor.mjs` owns one stable rehearsal data root for the lifetime of the supervisor and launches `render-private-testnet.mjs` beneath it. The launcher now treats an explicit `ZYRON_TESTNET_DATA_ROOT` as recoverable state:

- an existing `genesis.json` is reused instead of overwritten;
- all four validator key files must be present and must cryptographically match their stored public keys/addresses;
- the stored genesis must match the configured chain ID and the exact validator keys;
- a partial root (keys without genesis, missing keys, mismatched genesis) fails closed;
- validator data directories and signing journals are left intact and reused on restart.

When readiness reports `validator-clock-unhealthy`, the supervisor:

1. records the highest wall-clock sample it has observed;
2. stops the launcher and all validator children without deleting journals or rotating keys;
3. refuses restart until wall clock has advanced beyond that watermark plus a safety margin and remained non-decreasing for multiple samples;
4. enforces a bounded clock-restart budget to prevent restart loops;
5. restarts the launcher with the same data root;
6. requires the same genesis hash, no repeated clock fault, all validator processes alive, healthy readiness, and finalized height advancing beyond the pre-fault height;
7. otherwise remains fail-closed with a non-zero supervisor exit.

The restart safety wait is an operational guard, not a replacement for NTP/host-clock repair. Production validators must still use independently managed hosts, clock monitoring and operator procedures.

## CI evidence

The supervisor CI has three separate checks:

- deterministic fail-closed detection of `validator-clock-unhealthy`;
- ordinary supervised canonical-launcher smoke;
- `--test-recovery-once`, which runs the real four-validator launcher, waits for organic finality, drives the same recovery path used for a clock fault, preserves the same data root, requires `materialReused=true`, requires the same genesis hash after restart, and requires finalized height to advance again.

The recovery test intentionally does not inject a fake clock into consensus code. Direct `NodeService` regressions already prove that a genuinely faulted signer refuses further signing until process restart and that true backward clock movement still trips the safety guard. The supervisor rehearsal proves the operational restart/catch-up path around that invariant.

This remains one-host rehearsal evidence only. Public-testnet/mainnet operation still requires independent validator hosts/failure domains, production signer custody, sustained Internet soak, multi-region recovery drills and external review.
