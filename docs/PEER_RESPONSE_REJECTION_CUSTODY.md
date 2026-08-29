# Peer response rejection resource custody

Outbound HTTP peer responses are rejected fail-closed when the HTTP status is non-successful or the peer RPC API version is missing/incompatible. Rejection now also performs best-effort response-body cancellation before returning the existing error/empty peer contribution.

This cleanup applies to base sync/discovery/gossip/consensus HTTP helpers and to the bounded HTTP-consensus collector. A cancellation failure never converts a rejected peer response into an accepted response and never replaces the original protocol rejection.

Existing response Content-Type and Content-Length checks, aggregate wire/parse byte budgets, JSON complexity limits, request timeouts, peer chain-identity validation, authentication, reputation/backoff, consensus outbound concurrency/shared deadlines, quorum validation, and finality gates remain mandatory.

This is availability/resource-custody hardening only. It is not evidence of public mining, public testnet, or mainnet readiness and does not weaken any activation or security gate.
