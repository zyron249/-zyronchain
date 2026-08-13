# Peer reputation local file recovery

HTTP and native peer reputation snapshots are local non-secret state files. Both are read through the shared bounded UTF-8 reader before snapshot validation.

On POSIX systems the reader opens these files with no-follow and non-blocking flags, verifies the opened object is a regular file, and preserves the existing maximum-byte plus sentinel-read boundary. This prevents a substituted symlink or special-file path from becoming a different or blocking startup input before validation.

The change does not alter reputation entry limits, peer backoff rules, snapshot validation, or durable temporary-file/rename publication. Windows retains the existing compatible regular-file and byte-bound behavior without POSIX-only flags.
