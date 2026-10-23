# ZyronChain security policy

## Status

- The canonical chain is the standalone TypeScript L1 under `l1/`. The historical Python/Flask network is legacy compatibility software. Do not confuse it with the canonical chain.
- A public **no-value testnet** runs the L1 (`docs/OPEN_TESTNET.md`). There is no mainnet. Test ZYN has no value.
- **ZyronChain has not had a professional security audit.** All reviews so far are self-reviews and AI-assisted reviews. They are not audits. Do not rely on this code to protect anything of value.
- The project has no budget for a paid audit. Community review is welcome; see [`BUG_BOUNTY.md`](BUG_BOUNTY.md) for scope, severity tiers and rules.
- **No bug-bounty rewards are currently offered.** `BUG_BOUNTY.md` describes a planned program; reward amounts are not set and will be announced separately before any mainnet launch. Until then, nothing in this repository is an offer of payment.

## Supported versions

Only the latest commit on `main` is supported. No L1 release has been tagged yet. Fixes go to `main`; there are no backports.

## Reporting a vulnerability

**Use GitHub private vulnerability reporting:**
<https://github.com/zyron249/-zyronchain/security/advisories/new>
(Security tab → **Report a vulnerability**.)

Please **do not** open a public issue, pull request or discussion for an unfixed vulnerability. If you cannot use private reporting, open a minimal public issue that only asks for a private security contact, **without publishing exploit details, keys, secrets, proof-of-concept payloads, vulnerable endpoints, or instructions that would enable exploitation**.

A good report includes:

1. the commit hash you tested;
2. the affected component, file(s) and function(s), and the invariant ID from `docs/l1-audit-scope.json` it breaks, if any;
3. a reproduction the maintainers can run: ideally a failing `node --test` test, or a script against a local network (`l1/scripts/open-testnet.mjs` or `npm run devnet`);
4. expected and actual results, impact, and the severity you propose;
5. only the smallest safe evidence needed to confirm the issue.

Reporters must not need founder-only private context to make or validate a report. The intended review boundary is the public repository, release artifacts, threat model, audit-scope file and operator documentation.

Never send private validator keys, wallet keys, signer tokens, seed phrases or passwords, not even test ones, and not even to maintainers. Maintainers will never ask for them.

## Scope (summary)

In scope: everything under `l1/` (consensus v1 to v6, signing journal, supply and mining rejection, allocation locks, activity-oracle cap, genesis binding, snapshot/checkpoint/state sync, cryptography, P2P, RPC, governance, light clients), the open-testnet profile and its gateway, and the CI/release supply chain.

Out of scope: the legacy Python/Flask stack, `telegram-game/`, website/PWA/Snap, third-party infrastructure, volumetric denial of service, and issues already documented as known or accepted risks.

Details, severity tiers and rules: [`BUG_BOUNTY.md`](BUG_BOUNTY.md).

## Testing rules and safe harbor (summary)

- Test only the no-value testnet, or better, your own local copy. Never test third-party infrastructure.
- No denial of service against shared services, no social engineering, no access to other people's data.
- Good-faith research that follows these rules and [`BUG_BOUNTY.md`](BUG_BOUNTY.md) is considered authorised. The project will not take or support legal action against it. Safe harbor covers only systems the project controls.

## Response targets

Target response times are engineering goals, not guarantees: acknowledge a credible report within three business days and produce an initial severity/ownership assessment within seven business days when an active security-maintainer set exists. Coordinated disclosure is described in [`BUG_BOUNTY.md`](BUG_BOUNTY.md) section 5. Reporters are credited in the advisory unless they ask not to be.

## Response principles

Security response follows these rules:

- safety outranks liveness; do not lower quorum, bypass signing journals, patch consensus hashes, introduce emergency mint/admin authority, or trust peer-provided anchors to make an incident disappear;
- preserve logs, affected commit/release identifiers, evidence artifacts, and reproducible test cases;
- critical/high findings affecting consensus, cryptography, authenticated state, validator signing, supply, checkpoint trust, or remote attack surfaces are release stop-ship until remediated and independently retested where the readiness policy requires it;
- coordinate disclosure until a safe fix and operator guidance exist when early publication would materially increase exploitation risk;
- never request private validator keys, wallet keys, signer tokens, seed phrases, production credentials, or unrelated personal data from a reporter.

## Network authentication saturation

Authenticated peer-request replay protection is a security boundary, not a best-effort cache. Accepted signed request nonces remain remembered for the allowed replay window. The implementation uses a bounded replay cache and **fails closed for unseen authenticated peer requests if that cache reaches capacity after expiry sweeping**; it must never evict an unexpired accepted nonce merely to admit newer traffic, because eviction would reopen replay acceptance inside the timestamp window. Capacity saturation may therefore sacrifice short-term peer liveness in preference to replay safety.

Replay-cache expiry cleanup is amortized at the authentication boundary. Ordinary authenticated requests arriving before the earliest tracked nonce can expire do not rescan the full replay cache. Once the earliest expiry boundary is reached, expired entries are reclaimed and the next sweep deadline is recomputed. This preserves the full replay window and fail-closed saturation behavior while preventing the bounded cache from becoming a request-amplified O(n) CPU surface.

## Native P2P admission work

Native P2P peer-rate state is cardinality-bounded and fails closed for unseen identities while capacity is full. Expired entries are reclaimed without evicting unexpired peers. Expiry cleanup on this hot path is also amortized: ordinary requests and rotating identities that arrive before the earliest possible expiry do not trigger a full tracked-peer scan on every admission decision. This prevents bounded memory from becoming an avoidable request-amplified CPU surface while preserving the existing fixed-window quotas and fail-closed capacity behavior.

## Maintainer continuity

No personal mailbox or founder-only credential may be the sole security channel for a public ZyronChain network. The current open testnet carries no value and is not covered by this requirement. Before any value-bearing network or mainnet is authorized, the repository must have the independent maintainer/custodian evidence required by `docs/L1_MAINTAINER_SUCCESSION.md` and `docs/l1-maintainer-succession.json`.

Founder disappearance is not an emergency authorization mechanism. Public history, audit records, release attestations, genesis preparation, and security evidence must remain available; successors must operate from public/reviewed capabilities rather than reconstructing hidden founder authority.

## Open testnet state secret

The open testnet gateway seals its state snapshot with `ZYRON_TESTNET_STATE_SECRET`. The value is generated by the host (Render) and is copied only into the GitHub Actions secret of the same name, used by the scheduled snapshot keeper. The keeper job runs only on `refs/heads/main`, so a workflow dispatched from another branch cannot read it. The secret must never be printed, logged or committed; if it is exposed, rotate it on the host and in the Actions secret together. The testnet carries no value, and blocks above the newest published snapshot (`durableHeight`) can roll back on a gateway cold start. See `docs/OPEN_TESTNET.md`.

## Scope and launch status

A green CI run, security response, community review, bug-bounty report or policy check does not authorize a public testnet or mainnet that carries value, and is not a substitute for an independent audit. Current launch gates remain authoritative in `docs/STANDALONE_L1_READINESS.md` and `docs/L1_THREAT_MODEL.md`.
