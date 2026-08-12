# Layer-1 node identity custody

`node-identity.json` contains the long-lived private key used to authenticate a ZyronChain node to trusted peers. Treat it as operator secret material, not ordinary configuration.

## Runtime invariant

The canonical `loadOrCreateNodeIdentity()` path enforces the secret boundary itself:

- first creation uses exclusive `wx` creation with mode `0600`, then fsyncs the file and containing directory before returning the new identity;
- an existing identity is opened and read through the descriptor-bound private-file reader;
- symbolic-link identity paths are rejected;
- on POSIX, group/other permission bits are rejected and the opened descriptor must still match the path device/inode after validation;
- if concurrent first creation loses the `wx` race with `EEXIST`, the winning identity is re-opened through the same descriptor-bound private-file path before it is trusted;
- malformed or key-inconsistent persisted identities remain fail-closed.

These controls reduce local path-replacement, symlink and accidental-permission exposure risk. They do not turn local disk custody into an HSM or independently audited production signer. Public-testnet and mainnet activation remain subject to the external custody and operational evidence gates in `docs/l1-launch-authorization.json` and the readiness tracker.

## Operator guidance

Keep the node data directory private to the service account, preserve `0600` on `node-identity.json`, avoid sharing the identity file across hosts, and back it up only inside an encrypted, access-controlled recovery process. A replacement node identity changes peer authentication identity and must be treated as an explicit operational rotation rather than silent recovery.
