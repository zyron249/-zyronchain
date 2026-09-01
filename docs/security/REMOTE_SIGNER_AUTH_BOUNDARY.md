# Remote validator signer authentication boundary

ZyronChain treats a remote validator signer as a privileged custody boundary. The reusable `RemoteValidatorSigner` client therefore requires an explicit bearer credential before it can be constructed; authentication is not left solely to the CLI wrapper.

The credential must be 32–512 printable non-whitespace-header-safe ASCII bytes under the existing validation rule, is sent only in the HTTPS (or loopback HTTP) `Authorization: Bearer` header, and is never included in the signing payload or logs. Missing, empty, weak, or header-injection-capable credentials fail closed before any signing request is emitted.

Remote signer responses remain independently constrained: redirects are rejected, non-loopback plaintext HTTP is forbidden, response metadata and body size are bounded, the JSON response schema is exact, and the returned signature is verified against the pinned validator public key, exact payload, signing intent, and protocol signing domain.

This client-side authentication requirement does not establish production validator custody. Public-testnet activation still requires real HSM or independently audited remote-signer custody, credential/token policy, cross-host rotation/recovery, and independent operational evidence. It does not alter public-mining, public-testnet, or mainnet activation gates.
