# Bounded local state-file security

Status: pre-public-testnet local recovery/deployment hardening. This document does not authorize public testnet, mainnet, public mining, or release publication.

`readBoundedUtf8File()` is used for non-secret local state such as HTTP/native peer-reputation snapshots. Reads stay bounded by the caller-provided byte ceiling and are performed from one opened descriptor.

The reader freezes the initial canonical pathname and initial pathname device/inode identity, rejects a direct symbolic-link final component, validates that both the opened descriptor and current path are regular files immediately after open, and repeats the path/canonical validation after the bounded read before returning bytes to a parser. The opened descriptor's size, modification time, and change time are captured before bytes are consumed and revalidated after the read, so same-inode in-place mutation fails closed even when the file length does not change. POSIX additionally keeps `O_NOFOLLOW | O_NONBLOCK`. The post-open/post-read canonical checks cover parent symlink/junction/reparse substitution on platforms where `O_NOFOLLOW` cannot protect the full path.

This is an integrity and availability boundary for project-owned non-secret state files. It does not make an untrusted local account safe, replace filesystem ACLs, protect secret-key material, or provide deployment/readiness evidence. Secret files remain under the stricter `readPrivateRegularFile()` custody boundary.
