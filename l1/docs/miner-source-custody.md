# Miner package source custody

POSIX miner source custody is an evidence-building control for the quarantined miner packaging path. It is not a public-mining activation mechanism.

The native source-custody helper binds the canonical source root with a retained directory descriptor and opens descendants with `openat()` plus `O_NOFOLLOW`. For coordinated/adversarial reads, the target regular file is now opened before the coordination window is exposed, so later source-root, nested-directory, or source-file pathname replacement cannot substitute candidate bytes for that held read. Traversal, final-component symlinks, non-regular files, excessive path depth, and platforms without the required no-follow primitive fail closed.

This control is still incomplete for release readiness: the production miner materializer has not yet been converted to one retained source-custody session spanning source-tree enumeration and every candidate copy; generated launcher/README and the runtime executable still require explicitly bound or staged custody; and Windows still lacks a handle/reparse-safe equivalent. Issues #781 and #761 therefore remain open and the packaging quarantine/activation gates must remain enabled.

Required evidence before either issue can close includes deterministic source-root, nested-directory, and source-file replacement tests proving attacker-controlled replacement trees cannot inject candidate bytes, plus green general ZyronChain CI, Standalone L1 Node 22/24, Miner Package CI, Miner Release Candidate CI, and all other applicable gates on a fixed head SHA.
