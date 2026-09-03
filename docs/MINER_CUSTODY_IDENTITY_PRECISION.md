# Miner custody POSIX identity precision

Status: local release-candidate custody hardening only. This document is not evidence of public mining, public testnet, or mainnet readiness.

The POSIX miner materializer treats filesystem `st_dev` and `st_ino` values as security identities. Every security-relevant identity snapshot is captured with Node `lstat(..., { bigint: true })` so the value remains exact even when the native integer exceeds JavaScript's `Number.MAX_SAFE_INTEGER`.

Exact BigInt identities are retained through release-root session startup, `SOURCE`, `SOURCE_ENTER`, `COPYREL`, and the completion-time release-root pathname binding. Protocol serialization uses the decimal representation of the BigInt directly; security-relevant identity values must never be converted through JavaScript `Number`.

The native custody helper remains authoritative after opening retained descriptors: it compares the opened descriptor's device/inode identity against the exact expected values before acknowledging the corresponding operation. Existing descriptor-relative traversal, `O_NOFOLLOW`/`O_EXCL`, source-stability snapshots, durability barriers, and activation/publication gates remain unchanged and fail closed.

Regression coverage includes adjacent inode identities above 2^53 that collapse to the same JavaScript `Number`; the exact BigInt comparison must continue to distinguish them. Any future materializer change that reintroduces numeric identity coercion must fail CI.
