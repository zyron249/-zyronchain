# ZyronChain release-artifact operator rehearsal

Status: **pre-public-testnet engineering evidence**. This rehearsal does not authorize a public testnet or mainnet.

## Purpose

A founder-independent network cannot depend on private build instructions or an unpublished source-tree layout. A third party must be able to take the reviewed release package, install it in a clean environment, create non-production operator material, start nodes and recover them using only documented/public interfaces.

`l1/scripts/artifact-operator-rehearsal.mjs` exercises that boundary using the same npm tarball format produced by `npm pack`.

## Rehearsed sequence

The CI job:

1. builds the canonical L1 and produces exactly one `@zyronchain/l1` npm tarball;
2. hashes the tarball with SHA-256;
3. creates a fresh temporary operator directory outside the source tree;
4. installs only the generated tarball into that clean directory;
5. invokes the installed package's `dist/src/cli.js`, never the source-tree CLI, to create three ephemeral test keys and a two-validator genesis;
6. starts two installed-package validator processes with separate data directories and loopback RPC ports;
7. waits for organic finalized-block convergence;
8. cleanly stops one validator, restarts it from the same artifact/key/data directory, and requires exact chain/genesis/tip convergence;
9. outputs machine-readable evidence containing the package version, tarball digest, finalized height/tip and restart result but no private key material.

## What this proves

A successful run proves that the packed release artifact contains enough runtime code and package metadata for a clean operator install and that the installed artifact can execute the public keygen/genesis/node interfaces without importing the repository source tree at runtime.

It also gives a regression guard against accidentally shipping a tarball that passes source-tree tests but is missing runtime modules or cannot be operated after installation.

## What this does not prove

This CI runner is not an independent human/operator, provider, jurisdiction or security domain. It does not prove:

- independent operators can run the network across real Internet failure domains;
- production HSM/remote-signer custody;
- public validator admission/governance;
- persistent production storage or multi-region disaster recovery;
- independent reproducible builds on separately administered builders;
- external audit results;
- mainnet genesis, allocation or economics.

Those remain separate readiness gates. All generated keys and balances in this rehearsal are ephemeral and non-value-bearing.
