# Miner runtime source snapshot boundary

Miner release-candidate runtime materialization is fail-closed against in-place regular-file mutation as well as pathname replacement.

For each ordinary regular source file and each canonical in-root npm symlink target, the materializer binds the validated source to a descriptor snapshot containing device/inode identity, byte size, modification time, and change time. The opened descriptor must match that pre-open snapshot before any destination file is created. After all source bytes have been read, the descriptor is revalidated again; an in-place mutation during the copy aborts candidate construction rather than accepting a mixed or post-validation byte stream.

This rule complements, and does not replace, source-root confinement, directory identity checks, destination freshness/atomic creation, strict release-manifest coverage, platform signing/notarization, provenance, immutable-release review, or explicit public-mining activation. Passing this boundary is release-candidate integrity evidence only and is not public-mining, public-testnet, or mainnet readiness evidence.
