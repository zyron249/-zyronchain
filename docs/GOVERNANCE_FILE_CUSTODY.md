# Governance file custody boundary

Validator-set and protocol-governance proposal/approval files are local control-plane inputs, not network-trusted data. The published `zyron-l1` entrypoint therefore stages these files through a bounded descriptor-bound reader before the legacy CLI parser sees their bytes.

The boundary enforces a 1 MiB maximum per proposal/approval artifact, regular-file semantics, canonical path revalidation before/after descriptor reads, POSIX no-follow/non-blocking behavior, and 0600 staged copies in a private temporary directory. Repeated `--approval` inputs are staged independently and preserve their original order.

This hardening limits local memory/path-substitution risk. It does not authorize validator-set or protocol changes, does not weaken quorum/signature validation, and does not change public-testnet, mainnet, or mining activation gates.
