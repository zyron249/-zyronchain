# RPC response serialization memory boundary

ZyronChain RPC response admission now reserves a conservative upper bound from the same aggregate response-byte budget **before** calling `JSON.stringify`. The reservation is converted in place to the actual serialized body size after serialization, so the body remains accounted until the HTTP response emits `finish` or `close`. Serialization failure releases the transient reservation immediately.

Small RPC responses use a 4 MiB serialization upper bound. Finalized block batches explicitly use the existing 25 MiB sync-response bound. If an operator configures a lower aggregate response budget, the pre-serialization reservation is capped to that configured budget, so a response that could not fit the retained-body budget cannot allocate a larger admitted serialization allowance. If the actual serialized body exceeds its route allowance, the response fails closed.

The overload response is a fixed small JSON constant and does not invoke `JSON.stringify`, avoiding recursive pressure when response capacity is already exhausted. Existing request rate limits, request concurrency, response headers, block-sync byte limits, consensus/finality rules and activation gates are unchanged.

This is a process-local DoS hardening boundary, not evidence of public-testnet or mainnet readiness. Sustained deployment and adversarial capacity claims still require external evidence on the intended infrastructure.
