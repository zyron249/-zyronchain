# ZyronChain release-artifact operator rehearsal

Status: **pre-public-testnet engineering evidence**. This rehearsal does not authorize a public testnet or mainnet.

A founder-independent network cannot depend on private build instructions or an unpublished source-tree layout. `l1/scripts/artifact-operator-rehearsal.mjs` therefore builds the normal npm tarball, hashes it, installs only that tarball into a fresh temporary operator directory outside the source tree, and invokes the installed package CLI for key generation, genesis creation and node operation.

The rehearsal starts two validators from the installed artifact with separate data directories, waits for organic finality and exact tip/genesis convergence, gracefully restarts one validator from the same artifact/key/data directory and requires it to recover the same finalized chain. Evidence contains package version, tarball SHA-256, finalized height/tip and restart result; no private key material is printed.

This proves the packed release contains enough runtime code for a clean operator install and guards against source-tree-only success. It is still CI evidence, not an independent human/operator, provider, jurisdiction, production HSM, multi-region recovery, independent reproducible build, external audit, public validator admission or mainnet genesis/economics proof. All generated keys and balances are ephemeral and non-value-bearing.
