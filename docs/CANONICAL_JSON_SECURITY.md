# Canonical JSON security boundary

ZyronChain canonical JSON is consensus infrastructure. Key ordering and the canonical byte representation remain unchanged for valid protocol objects.

To keep pre-validation serialization from becoming a stack-exhaustion path, canonical normalization rejects object/array container nesting deeper than 64 levels. All canonical protocol structures are intentionally far shallower than this ceiling. The bound therefore rejects malformed/adversarial inputs without changing any valid block, transaction, genesis, checkpoint, mining-work, signature-domain or interoperability vector.

Canonical serialization also rejects cyclic in-process object graphs deterministically. Reusing the same acyclic child object in multiple fields remains valid; only an ancestor cycle is rejected.

This boundary complements, rather than replaces, existing block/RPC/P2P byte and cardinality limits. Callers must still apply their protocol-specific shape, byte, signature, quorum, mining and chain-identity validation. Public-testnet and mainnet activation gates are unaffected.
