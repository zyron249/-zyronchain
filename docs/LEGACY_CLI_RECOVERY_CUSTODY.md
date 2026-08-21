# Legacy CLI recovery file custody

The published `zyron-l1` entrypoint continues to stage operator-controlled recovery files through `secure-cli`. Direct invocation of the compiled legacy CLI is defense-in-depth hardened as well.

Recovery and node-state commands read `--genesis` through the same bounded descriptor/path-custody reader. Direct `checkpoint-install` reads `--snapshot` through the SHA-256-anchored bounded checkpoint reader before structural scanning and JSON parsing. This preserves the 256 KiB genesis ceiling, 64 MiB checkpoint ceiling, canonical-path freeze, post-open/post-read revalidation, POSIX no-follow/non-blocking behavior, digest-before-parse ordering, and checkpoint JSON complexity gate.

Published secure staging remains the supported entrypoint and is not bypassed or weakened by this additional layer. Semantic checkpoint validation, finalized-history/governance/State-v2 checks, consensus/finality, validator key custody, mining/rewards, and every public-mining/public-testnet/mainnet activation gate remain unchanged. This local integrity/availability hardening does not satisfy target-hardware recovery evidence.
