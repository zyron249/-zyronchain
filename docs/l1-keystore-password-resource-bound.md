# Keystore password resource bound

ZyronChain local encrypted-keystore operations enforce a common password resource ceiling before invoking scrypt.

- Passwords must contain at least 12 characters.
- Passwords must not contain NUL, LF, or CR characters.
- Passwords are limited to 1,024 UTF-8 bytes at the shared encryption/decryption API boundary.
- Password files remain limited to 1,024 UTF-8 bytes before line-ending normalization.
- The limit is byte-based so multibyte input cannot exceed the intended KDF-input resource boundary through JavaScript code-unit counting.

This hardening does not change the keystore format, AES-256-GCM authentication, scrypt parameters, validator/miner activation policy, or any public-network readiness gate. It is a local key-custody availability/resource bound and is not evidence of public mining, public-testnet, or mainnet readiness.
