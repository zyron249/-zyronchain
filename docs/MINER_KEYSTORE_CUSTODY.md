# Miner keystore custody

The standalone miner accepts only the authenticated encrypted ZyronChain keystore format. Plaintext private-key JSON remains rejected.

Before the encrypted keystore reaches `JSON.parse`, the already bounded local-secret text is scanned for structural complexity. Nesting depth is capped at **32** and object/array structural tokens at **4,096**. Braces, brackets, commas and colons inside quoted JSON strings are ignored by this preflight and backslash escaping is respected.

This parser preflight is additive to the existing local-secret custody boundary: the keystore and password files remain subject to the 64 KiB outer file ceiling, canonical pathname and descriptor identity checks, same-inode content-snapshot validation, effective-user ownership and restrictive POSIX permissions where applicable, no-symlink handling and mutable read-buffer cleanup. The encrypted keystore continues to require its exact authenticated schema and the existing scrypt/AES-256-GCM validation path.

These controls bound avoidable parser/object-graph work from malformed local miner keystore input. They do not weaken signing, checksum, provenance, immutable-release or public-mining activation gates and are not evidence of public mining, public-testnet or mainnet readiness.
