# Peer response rejection resource custody

Outbound HTTP peer responses are rejected fail-closed when the HTTP status is non-successful or the peer RPC API version is missing/incompatible. Rejection also initiates best-effort response-body cancellation, but protocol rejection does not wait for cancellation settlement. A stalled cleanup therefore cannot hold open an already-rejected peer response.

This cleanup applies to base sync/discovery/gossip/consensus HTTP helpers and to the bounded HTTP-consensus collector. Synchronous cancellation throws and asynchronous cancellation rejection are ignored for cleanup purposes: neither can convert a rejected peer response into an accepted response, replace the original protocol rejection, or delay that rejection.

Existing response Content-Type and Content-Length checks, aggregate wire/parse byte budgets, JSON complexity limits, request timeouts, peer chain-identity validation, authentication, reputation/backoff, consensus outbound concurrency/shared deadlines, quorum validation, and finality gates remain mandatory.

This is availability/resource-custody hardening only. It is not evidence of public mining, public testnet, or mainnet readiness and does not weaken any activation or security gate.
