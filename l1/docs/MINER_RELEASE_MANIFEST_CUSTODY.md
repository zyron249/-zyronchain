# Miner release manifest custody

`SHA256SUMS` is release-candidate identity evidence, not scratch state. The generator therefore treats the `.SHA256SUMS.*.tmp` namespace as reserved exclusively for its atomic publication transaction.

A stale regular file or directory in that namespace indicates an interrupted or externally modified publication boundary. Manifest generation fails closed instead of silently deleting, traversing, hashing, or shipping that state. Operators must inspect and clean the candidate tree before retrying. This keeps release identity independent of crash leftovers and prevents internal publication scratch files from becoming release artifacts.

This rule complements, rather than replaces, the existing release controls: candidate inputs remain regular-file and symlink-safe, descriptor-bound while hashing, canonical release-root-relative in `SHA256SUMS`, and protected against ambiguous control/backslash path serialization. The final manifest is still written through a fresh exclusive temporary regular file, fsynced, and atomically renamed over the final leaf.

This hardening is packaging integrity evidence only. It does not prove signed end-user miner availability, public-mining activation, public-testnet readiness, or mainnet readiness, and it does not weaken any signing, provenance, immutable-release, consensus/finality, or activation gate.
