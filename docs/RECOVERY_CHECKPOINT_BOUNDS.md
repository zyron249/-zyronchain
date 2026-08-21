# Local recovery checkpoint resource bounds

The local `recovery-checkpoint.json` fast path is optional recovery metadata, never a trust source above finalized history. The reader therefore fails closed before JSON materialization when the file is oversized, structurally pathological, non-regular, or changes identity while being read.

- The file ceiling is 65 MiB: enough for the canonical <=64 MiB snapshot format plus checkpoint envelope metadata.
- The shared bounded-file reader freezes the canonical path before open, validates the opened regular descriptor, and revalidates the pathname after open and after the bounded read. POSIX also uses no-follow/non-blocking flags.
- Checkpoint JSON is scanned with the canonical checkpoint depth/cardinality limits before `JSON.parse()`.
- Invalid checkpoint input disables the fast path and falls back to authoritative finalized-history replay. If finalized history has already been pruned, the existing invariant still requires a valid compatible checkpoint and startup fails closed instead of inventing state.

This control reduces local recovery memory/TOCTOU exposure. It does **not** close the target-hardware recovery evidence required by issue #383 and does not change public-testnet, mainnet, mining, governance, consensus, or finality activation gates.
