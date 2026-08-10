# ZyronChain maintainer and security succession

Status: **prepared policy; independent-custodian evidence still required**. This document does not itself grant or activate a public testnet or mainnet and does not name or create successor credentials. Global network-class governance authorization is recorded separately in `l1-launch-authorization.json`.

## Objective

A public ZyronChain network must remain buildable, reviewable, releasable, recoverable and security-responsive if any founder or maintainer disappears. Succession is transfer of verified capability, not deletion of history and not creation of a hidden recovery authority.

## Required continuity domains

Before public-testnet **activation**, responsibility must be demonstrably transferable across all of these domains:

1. **Repository administration** — reviewed source, issues, pull requests, branch/release policy and project history remain accessible without one person's account.
2. **Release and tagging** — at least two independent custodians can reproduce the release, verify checksums/SBOM/attestations and execute the reviewed release procedure without sharing a personal static secret.
3. **Security response** — vulnerability reports can reach an active maintainer set through the repository security process; no founder-only mailbox or private relationship is required.
4. **Domain and checkpoint publication** — loss of one operator, domain account or checkpoint publisher cannot silently create a new trust root. Genesis/checkpoint anchors remain independently authenticated and published through reviewed channels.
5. **Operator documentation** — third parties can build, install release artifacts, restore, upgrade, roll back and rotate validators from public documentation and evidence.

`docs/l1-maintainer-succession.json` is a profile-specific policy file that cannot authorize a network by itself. It requires at least two independent maintainers/custodians before public-testnet activation. Independence means the roles are not merely two accounts controlled by one person or one shared credential/failure domain.

## Forbidden shortcuts

Succession must never depend on:

- a unique founder admin/recovery/mint key;
- copying validator private keys between operators;
- lowering finality/governance quorum to compensate for missing maintainers;
- deleting signing journals or rewriting finalized history;
- accepting a checkpoint, genesis, validator set or software release solely because a former founder published it;
- reconstructing unpublished private instructions or credentials after a maintainer disappears.

If capability cannot be transferred with the public repository, reviewed artifacts and independently controlled credentials, the relevant activation gate remains open even when governance authorization for the network class exists.

## Maintainer-loss procedure

When a maintainer or credential custodian becomes unavailable:

1. preserve repository, release, audit and incident evidence;
2. inventory which continuity domains lost an independent custodian;
3. freeze affected release/security automation if the remaining ownership is ambiguous;
4. rotate repository/release/domain credentials using the service provider's reviewed process without copying validator keys or changing consensus rules;
5. reproduce the current release from a clean environment and verify checksums, SBOM and attestations;
6. run the documented restore, upgrade/rollback and validator-rotation rehearsals appropriate to the affected role;
7. restore the minimum independent custodian count before treating the succession activation gate as closed again;
8. publish the operational change without erasing prior maintainers, Git history, audit findings or provenance.

## Founder exit acceptance evidence

Founder-independent operation is not established by this document alone. Before a public-testnet **activation claim**, retain evidence that independent non-founder operators/custodians can, without private assistance:

- install and operate the L1 from a release artifact;
- reproduce and verify a release;
- receive and triage a security report;
- restore an independently anchored checkpoint and catch up;
- participate in a validator-key/set rotation under normal quorum rules;
- execute an upgrade/rollback rehearsal;
- maintain bootstrap/archive/monitoring and checkpoint publication across independent failure domains.

Actual identities, credentials, domains and custody assignments are operational evidence and must not be invented or committed as fake placeholders merely to satisfy CI.

## Relationship to consensus governance

Repository maintainership is not validator voting power. This policy does not decide validator admission, token allocation, rewards, oracle governance or mainnet genesis. Those remain explicit launch/governance decisions. Likewise, losing a repository maintainer does not grant remaining maintainers authority to bypass on-chain quorum rules.

Network-class governance authorization and this continuity policy are separate controls: authorization can be granted while activation remains blocked until independent-custodian evidence is closed.

## Verification

`l1/scripts/verify-maintainer-succession.mjs` validates the machine-readable policy, required public safety text and activation-blocking external evidence. Required CI emits a deterministic checksum-protected policy result. A green result proves only that the public succession package is internally coherent; it does not prove that two genuinely independent humans or organizations currently hold the required capabilities.
