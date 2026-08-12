# Finalized block-log initialization durability

Status: **pre-mainnet storage safety invariant**. This document does not authorize public testnet or mainnet activation.

`blocks.ndjson` is the canonical finalized-history log used by `ChainStore` recovery. A newly created log must not be treated as usable merely because the pathname is visible in the current process.

Before `ChainStore.open()` succeeds, the node now:

1. opens/creates `blocks.ndjson` with owner-only creation mode;
2. fsyncs that file handle;
3. closes the handle;
4. fsyncs the parent data directory so the canonical directory entry is durable;
5. only then proceeds to replay/checkpoint and derived State-v2 recovery.

If any part of this initialization persistence boundary fails, startup fails closed with `Finalized block log initialization persistence failed`. The node must not finalize blocks from that store instance. A clean restart re-enters the same initialization/replay path.

This complements, rather than replaces, the existing finalized append invariant: every finalized block record is validated before append, appended before in-memory tip mutation, and fsynced before the chain advertises the new finalized tip. State-v2 files remain derived recovery state; finalized history/checkpoint evidence remains authoritative.

Regression coverage injects a failure after the finalized-log file fsync but before directory durability completes, verifies startup fails closed, and verifies a clean restart safely reopens at the authoritative finalized prefix.

This is repository hardening evidence only. Public-testnet and mainnet activation remain gated by the independent operational, audit, custody, capacity and sustained adversarial evidence tracked in `STANDALONE_L1_READINESS.md` and the launch-authorization policy.
