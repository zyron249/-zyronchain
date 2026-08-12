# ZyronChain security policy

ZyronChain is pre-public-testnet software. The canonical security target is the standalone TypeScript L1 under `l1/`; the historical Python/Flask network is legacy compatibility software and must not be confused with the canonical chain.

## Reporting a vulnerability

Prefer GitHub's private vulnerability-reporting / Security Advisory channel for this repository when it is available. If no private channel is available, open a minimal public issue requesting a private security contact **without publishing exploit details, keys, secrets, proof-of-concept payloads, vulnerable endpoints, or instructions that would enable exploitation**.

A valid report should identify the affected commit or release, affected component, impact, reproduction conditions, and the smallest safe evidence needed to confirm the issue. Reporters must not need founder-only private context to make or validate a report; a maintained public repository, release artifacts, threat model, audit handoff, and operator documentation are the intended review boundary.

## Response principles

Security response follows these rules:

- safety outranks liveness; do not lower quorum, bypass signing journals, patch consensus hashes, introduce emergency mint/admin authority, or trust peer-provided anchors to make an incident disappear;
- preserve logs, affected commit/release identifiers, evidence artifacts, and reproducible test cases;
- critical/high findings affecting consensus, cryptography, authenticated state, validator signing, supply, checkpoint trust, or remote attack surfaces are release stop-ship until remediated and independently retested where the readiness policy requires it;
- coordinate disclosure until a safe fix and operator guidance exist when early publication would materially increase exploitation risk;
- never request private validator keys, wallet keys, signer tokens, seed phrases, production credentials, or unrelated personal data from a reporter.

Target response times are engineering goals, not guarantees: acknowledge a credible report within three business days and produce an initial severity/ownership assessment within seven business days when an active security-maintainer set exists.

## Network authentication saturation

Authenticated peer-request replay protection is a security boundary, not a best-effort cache. Accepted signed request nonces remain remembered for the allowed replay window. The implementation uses a bounded replay cache and **fails closed for unseen authenticated peer requests if that cache reaches capacity after expiry sweeping**; it must never evict an unexpired accepted nonce merely to admit newer traffic, because eviction would reopen replay acceptance inside the timestamp window. Capacity saturation may therefore sacrifice short-term peer liveness in preference to replay safety.

Replay-cache expiry cleanup is amortized at the authentication boundary. Ordinary authenticated requests arriving before the earliest tracked nonce can expire do not rescan the full replay cache. Once the earliest expiry boundary is reached, expired entries are reclaimed and the next sweep deadline is recomputed. This preserves the full replay window and fail-closed saturation behavior while preventing the bounded cache from becoming a request-amplified O(n) CPU surface.

## Native P2P admission work

Native P2P peer-rate state is cardinality-bounded and fails closed for unseen identities while capacity is full. Expired entries are reclaimed without evicting unexpired peers. Expiry cleanup on this hot path is also amortized: ordinary requests and rotating identities that arrive before the earliest possible expiry do not trigger a full tracked-peer scan on every admission decision. This prevents bounded memory from becoming an avoidable request-amplified CPU surface while preserving the existing fixed-window quotas and fail-closed capacity behavior.

## Maintainer continuity

No personal mailbox or founder-only credential may be the sole security channel for a public ZyronChain network. Before public-testnet authorization, the repository must have the independent maintainer/custodian evidence required by `docs/L1_MAINTAINER_SUCCESSION.md` and `docs/l1-maintainer-succession.json`.

Founder disappearance is not an emergency authorization mechanism. Public history, audit records, release attestations, genesis preparation, and security evidence must remain available; successors must operate from public/reviewed capabilities rather than reconstructing hidden founder authority.

## Scope and launch status

A green CI run, security response, or policy check does not authorize a public testnet or mainnet. Current launch gates remain authoritative in `docs/STANDALONE_L1_READINESS.md` and `docs/L1_THREAT_MODEL.md`.
