# RPC rate-limit identity cardinality

ZyronChain treats rate-limit bookkeeping as a bounded resource. Per-client request quotas alone are not enough: a source that can rotate through many valid network identities could otherwise grow the in-memory identity table even while respecting each individual quota.

The hardened fixed-window limiter therefore applies two layers of control:

- At most **4,096** RPC identities are tracked independently in the default production configuration.
- Once that cap is full, previously unseen identities share one bounded overflow bucket for the current fixed window.
- Existing tracked identities are **not evicted** to make room for new identities. Eviction would let an attacker rotate identities to reset per-client quota state.
- Overflow state expires only according to the same fixed-window timing rule; identity rotation does not create a fresh quota.
- Trusted-proxy identity parsing remains a separate boundary: only the already-validated trusted-proxy path may derive a client identity from `X-Forwarded-For`.

This bound is a liveness/availability hardening measure. It does not make public RPC or public testnet activation safe by itself, and it does not weaken any launch authorization, HTTPS proxy, peer authentication, or activation gate.

Regression coverage lives in `l1/test/rpc-rate-limit-cardinality.test.ts` and verifies bounded tracked state, shared overflow quota, fixed-window reset behavior, and preservation of already-tracked client quotas while overflow is saturated.
