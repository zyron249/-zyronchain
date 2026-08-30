# Miner packaging quarantine

## Security/readiness status

Self-contained miner artifact materialization is intentionally disabled until issue #761 supplies true handle-relative filesystem custody for the release root, bundle root, and nested destination directories.

The current pathname-based packager cannot truthfully satisfy the zero-external-byte replacement guarantees required by #757, #683, and #636. Rechecking `lstat`/`realpath` or narrowing the race window is not an acceptable substitute.

A POSIX descriptor-relative custody foundation exists under `l1/native/miner-custody-posix.c`. It uses `open(..., O_DIRECTORY|O_NOFOLLOW)`, `openat`, and `mkdirat` with exclusive child creation semantics. Its long-lived `session` mode binds the release-root descriptor once, descends through child directories with retained descriptors using `ENTER`/`LEAVE`, and now supports binary `COPY` into the retained destination descriptor without reopening an attacker-replaceable destination pathname.

The adversarial POSIX probe covers release-root and nested destination replacement. It renames a bound nested `scripts` directory, replaces the original pathname with a symlink to an external sentinel directory, then proves both a text `WRITE` and a binary `COPY` reach only the retained descriptor and write zero candidate bytes through the replacement path.

Miner Package / Miner Release Candidate CI compile and exercise the primitive on Linux and macOS. Windows explicitly treats this POSIX primitive as unsupported and remains protected by the packaging quarantine. This remains custody-primitive evidence only: `package-miner.mjs` has not yet moved candidate materialization into the descriptor session, recursive source-tree enumeration/copy integration is not complete, and this work therefore does **not** satisfy or close #761 by itself.

While this quarantine is active:

- `l1/scripts/package-miner.mjs` fails closed before binding or creating `l1/miner-release`;
- there is no unsafe environment or CLI bypass;
- Miner Package CI and Miner Release Candidate CI exercise the fail-closed gate on supported operating systems instead of publishing candidate bundles;
- the POSIX custody probe is evidence about the primitive only, not evidence that package materialization is safe;
- no SBOM/checksum/attestation produced by those workflows may be interpreted as miner release evidence because no miner candidate is materialized;
- public mining activation remains independently gated and false;
- #761, #757, #683 and #636 remain open.

## Exit gate

A reviewed change may remove the quarantine only after package materialization itself is anchored to retained handles/descriptors for the release root, bundle root and nested destinations, and adversarial tests prove release-root, bundle-root and nested-directory replacement cannot cause even one candidate byte to be written outside the bound release tree. Platforms without an audited implementation must continue to fail closed explicitly rather than silently falling back to pathname-only operations. The replacement change must pass the general ZyronChain CI, Standalone L1 Node 22/24, Miner Package CI, Miner Release Candidate CI, and every other applicable security/readiness gate on one fixed head SHA.

This document is a containment/readiness record. It does not claim that public mining, public testnet, or mainnet is ready.
