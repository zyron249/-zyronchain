# Node identity custody boundary

`node-identity.json` is long-lived private node identity material. It must never be published at its final path until the complete canonical identity bytes are durable.

## First-create publication

A first creator writes a unique owner-only temporary file in the node data directory, fsyncs the complete file, and only then atomically creates the final `node-identity.json` name with a no-replace hard link. A concurrent creator that loses this publication race observes `EEXIST` only after the winner's complete fsynced bytes are reachable at the final path, then loads that final identity through the descriptor-bound private-file reader.

The data directory is fsynced after publication. Temporary identity paths are removed and the directory is synced again after successful publication so cleanup is crash-durable. Existing durable-directory ancestry, owner-only custody, persisted-file descriptor binding, key/public-key/node-ID validation, and restart identity continuity remain mandatory.

## Security invariants

- A concurrent process must never trust partially written final identity bytes.
- Publication must never overwrite an existing node identity.
- The final identity is usable only after complete-file fsync and atomic no-replace publication.
- Persisted reads continue to reject symlinks, non-regular files, unsafe POSIX permissions, and path/descriptor identity changes.
- A restart must recover the same node identity; no P2P identity-binding or activation gate is weakened by this mechanism.
