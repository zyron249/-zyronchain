# Chain control metadata recovery

The Layer-1 startup path treats `metadata.json` and `history-retention.json` as small control files.

Both files have a 4 KiB read limit. The reader opens the file once, verifies that the opened object is a regular file, and reads at most the configured limit plus one sentinel byte. On POSIX systems it also opens with no-follow and non-blocking flags, so symlinks and special files are rejected rather than followed or allowed to block startup.

The existing validation rules are unchanged. Chain metadata must still match the store version, chain ID, and genesis hash. History-retention metadata must still match the expected version, exact field set, chain identity, and valid retained-history boundary.

`recovery-checkpoint.json` is intentionally outside this small-file limit because it may contain a full snapshot. Its size and parsing strategy require separate treatment.
