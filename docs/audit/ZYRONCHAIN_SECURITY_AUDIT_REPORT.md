# ZyronChain L1 Security / Correctness Audit Report

**Date:** 2026-09-28 (America/New_York)  
**Auditor role:** Internal automated review (AI executor pass); not an independent audit and not human sign-off (label corrected 2026-09-30, ZC-CRY-20260930-009)  
**Clone:** `/workspace/zyron-l1/-zyronchain`  
**Audit branch:** `audit/security-20260928`  
**Consensus candidate tip audited:** `d6aa19e4043527a13cbe98fb2b5e648ff2661e7e` (`cursor/round-view-change-liveness-068e`, #904+#903)  
**Compared against `main`:** `8794b4e2becc0ae33b2df2fd6824847327e43be6`  
**Canonical chain:** TypeScript `l1/`  
**Ticker:** ZYN (not ZYR)  
**Hard cap:** `MAX_SUPPLY_ATOMS = 50_000_000 * 100_000_000 = 5_000_000_000_000_000` (safe integer)

> Do not trust prior Gate 0/1 AI claims or comments alone. This report cites code paths, failing/passing tests, and commands actually run.

---

## Executive summary

ZyronChain L1 is a **permissioned BFT-style PoA** chain with optional protocol-v5 **issuance PoW** (`mining_claim`) under a hard 50M ZYN historical cap. PR #904 introduces a prepare→commit and view-change liveness path intended to recover split quorum states without lowering `Q = floor(2N/3)+1`.

**This pass actively tried to break safety.** Bounded exploration for N=3,4,7 reported zero reachable double-finalization under the modeled adversary. Adversarial unit tests rejected forged/cross-height/duplicate-identity certificates. **No CRITICAL consensus safety break was proven.**

**One HIGH liveness/accountability bug was proven and fixed** on the audit branch: skip-then-attest recovery failed to persist the prepare lock certificate (ZC-AUD-001). Additional medium/low defense-in-depth issues were fixed or documented.

**Mainnet readiness:** **NOT READY** for claims of decentralized, battle-tested security. Remaining blockers are operational decentralization (ZC-AUD-007), independent human consensus review (ZC-AUD-010), unique-hash lock durability (ZC-AUD-009), and library-layer RPC auth fail-closed behavior (ZC-AUD-008).

### Findings counts

| Severity | Count | Fixed on audit branch | Remaining |
| --- | ---: | ---: | ---: |
| CRITICAL | 0 | 0 | 0 |
| HIGH | 2 | 1 | 1 (operational PoA gate) |
| MEDIUM | 4 | 2 | 2 |
| LOW | 2 | 1 | 1 |
| INFORMATIONAL | 2 | 0 | 2 |
| **Total** | **10** | **4** | **6** |

Machine-readable detail: [`FINDINGS.json`](./FINDINGS.json).

---

## Multi-pass methodology

1. **Pass 1 (conventional):** Architecture map, quorum math, mint paths, RPC classification, journal/fsync review, PR #904 diff vs `main`.
2. **Pass 2 (adversarial):** Forged certs, duplicate identity, cross-height/chain replay, split prepares, nil-VC finality refusal, supply overflow, skip-recovery lock gap, genesis tracker bypass via `LedgerState.fromGenesis`.
3. **Pass 3 (re-review after fixes):** Re-ran focused audit suites and full `npm test`; confirmed ZC-AUD-001/002/003/004 patches; documented remainders.

Commands recorded:

```text
cd l1 && npm ci
npm run typecheck          # PASS
npm test                   # before fixes: 690 pass / 0 fail
npm audit --omit=dev --audit-level=high   # 0 vulnerabilities
# after fixes + audit tests:
npm test                   # 711 pass / 0 fail
node --test dist/test/audit-*.test.js     # 21 pass / 0 fail
```

---

## Phase results

### 1. Architecture map

See [`ARCHITECTURE_MAP.md`](./ARCHITECTURE_MAP.md). Critical consensus surface is concentrated in `block.ts`, `round-view-change.ts`, `node-base.ts`, `storage.ts` (SigningJournal), `chain.ts`, `mining.ts`, `crypto.ts`.

### 2. Consensus safety

| Check | Result |
| --- | --- |
| Quorum N=1..100 | `Q=floor(2N/3)+1`; honest intersection ≥1 |
| Double-finality (bounded N=3,4,7) | 0 reachable without honest double-sign |
| Equivocation local | Journal rejects conflicting attest/skip/prepare |
| Duplicate identity padding | Rejected |
| Stale/cross-height/cross-chain prepares | Rejected (chainId/height/round/hash bound) |
| Forged certs (unknown voter) | Weight 0 / throw |
| Nil VC finalizes? | **No** (attestation quorum still required) |

**UNCERTAIN:** full asynchronous network + Byzantine scheduling outside the bounded model.

### 3. Liveness

| Check | Result |
| --- | --- |
| Split 2+2 / plurality finalize | Refused (completion null) |
| Round-change bound | `f+1` honest proposers after ambiguous round |
| Leader withhold | Round skip / VC after deadline |
| Skip-then-attest lock durability | **Was broken → FIXED (ZC-AUD-001)** |
| Unique-hash commit without lock file | **REMAINING risk (ZC-AUD-009)** |
| Permanent halt with safety | Expected when >f crash; safety preferred |

### 4. Crash / recovery / storage

- Signing journal: fsync + lease; conflicting history fails closed.
- Lock certificates: fsynced; now also written on skip-recovery commits.
- Double-sign after restart: journal replay prevents conflicting hash (existing tests).
- Finalized log: append/fsync before tip advance (existing durability suite).

### 5. P2P adversarial input

- Native frames: max byte budgets, fuzz decoder test present.
- Reputation / rate limits exist.
- **NOT TESTED in depth this pass:** full eclipse simulation, malicious multiaddr storms beyond existing suites.

### 6. RPC classification

| Class | Examples | Notes |
| --- | --- | --- |
| PUBLIC SAFE (read) | `/status`, `/balance`, `/nonce`, `/healthz` | Rate-limited |
| PUBLIC WRITE | `/tx` | Mempool admission; not consensus signing |
| CONSENSUS / VALIDATOR | `/proposal/*`, `/round/*`, `/block` | CLI requires auth off-loopback |
| OPERATOR | `/metrics`, `/peers`, `/blocks` | Sensitive operational data |
| INTERNAL | journal, keystore, remote signer | Not HTTP-exported |

Trust-proxy: empty trusted list ignores `X-Forwarded-For` for rate-limit identity; configured proxies require `x-forwarded-proto: https`.

### 7. Crypto / domain separation

- secp256k1 via `@noble/curves` **default prehash SHA-256** (verified).
- Domains: block-proposal, finality-attestation, round-skip, round-prepare, round-view-change, tx kinds, mining-work, governance approvals.
- Protocol ≥3 / tx v2 use `signCanonicalDomain`.
- Double nesting of prepare/VC domain fields: INFORMATIONAL (ZC-AUD-005).
- `@noble/curves` pinned direct (ZC-AUD-004).

### 8. Tx validation

- Exact-key shapes, safe integers, address checks, nonce sequencing on apply.
- amount+fee overflow now rejected at shape (ZC-AUD-003).
- Double-spend: nonce + pending spend accounting in mempool path.

### 9. Economics — 50M ZYN

**Proven under code + tests:**

- Cap constant exact and safe-integer.
- Genesis supply cannot exceed cap (`validateGenesis` / `fromGenesis`).
- Only mint paths: genesis + `mining_claim` (schedule-bound).
- Fees burn; burns do not reopen mining budget (schedule uses `genesisSupplyAtoms` + claim count).
- Activity settlement redistributes pool only.
- Saturating claim count → reward 0; cumulative issuance ≤ remaining budget.

### 10. Governance / upgrades

- Validator set / protocol upgrades need current-set quorum approvals + activation delay.
- Unsupported protocol versions fail closed on activation.
- **NOT TESTED:** social/emergency governance process (out of code scope).

### 11. Genesis / chain identity

- `chainId` regex `^[a-z0-9-]{3,64}$`; encoded in blocks/txs/votes.
- Genesis hash binds checkpoints.
- Mining tracker cannot be allocated (chain + now ledger).

### 12–13. Adversarial tests & invariant coverage

New suites:

- `l1/test/audit-skip-recovery-lock-cert.test.ts`
- `l1/test/audit-consensus-adversarial.test.ts`
- `l1/test/audit-supply-economics.test.ts`
- `l1/test/audit-rpc-classification.test.ts`
- `l1/test/audit-invariants.test.ts`

See [`INVARIANT_COVERAGE.md`](./INVARIANT_COVERAGE.md).

### 14. Code quality affecting security

- Large `node-base.ts` (~3k LOC) concentrates RPC + consensus — reviewability risk.
- Optional auth at library layer vs CLI enforcement.
- Prepare payload domain double-wrap complexity for remote signers.

### 15. Dependencies

```text
npm audit --omit=dev --audit-level=high
# found 0 vulnerabilities
```

Direct-pinned `@noble/curves@2.3.0` on audit branch. Do not blindly upgrade libp2p/noise stacks without consensus re-qualification.

---

## Dedicated PR #904 deep review

### Intent

`5ed3dc1 fix(consensus): add safe round-change liveness for split quorum states` — prepare is not commit; when two hashes can still reach quorum, completion stays null; nil view-change opens next round for N=4/N=7 without lowering Q.

### vs pre-PR `main`

- `main` lacked `round-view-change.ts` and the prepare/VC wire types.
- #904 adds lock-certificate store, journal prepare/view phases, HTTP/native VC routes, and large qualification tests.
- Public-testnet scaffolding is bundled on the same branch tip but is orthogonal to consensus safety.

### Assessment

| Topic | Assessment |
| --- | --- |
| Safety vs `main` | Improves explicit lock/prepare accounting; no evidence of lowered quorum |
| Liveness | Materially better for split states; ZC-AUD-001 was a real gap in recovery durability |
| Compatibility | Mixed-version / 1.0 rejection claimed in author package — rely on qualification tests |
| Readiness | Still **draft/candidate**; author package forbids “INDEPENDENT REVIEW PASSED” |

**Verdict:** Treat #904 tip as the correct review target for consensus. **Do not mainnet** without external review and remaining HIGH/MEDIUM closures.

---

## Findings (summary table)

Full mandatory fields live in [`FINDINGS.json`](./FINDINGS.json).

| ID | Sev | Title | Status |
| --- | --- | --- | --- |
| ZC-AUD-001 | HIGH | Skip-then-attest omitted lock certificate | **FIXED** |
| ZC-AUD-002 | MEDIUM | `LedgerState.fromGenesis` allowed tracker allocation | **FIXED** |
| ZC-AUD-003 | LOW | amount+fee Number overflow at shape | **FIXED** |
| ZC-AUD-004 | MEDIUM | `@noble/curves` transitive-only | **FIXED** |
| ZC-AUD-005 | INFO | Prepare/VC double domain nesting | REMAINING (doc) |
| ZC-AUD-006 | LOW | State-v2 mining lacks explicit total-supply check | REMAINING |
| ZC-AUD-007 | HIGH | PoA decentralization / f=0 for N≤3 | REMAINING (gate) |
| ZC-AUD-008 | MEDIUM | `createRpcServer` unauthenticated consensus possible | REMAINING |
| ZC-AUD-009 | MEDIUM | Unique-hash commit without lock durability | REMAINING |
| ZC-AUD-010 | INFO | No independent formal verification | REMAINING |

---

## Test counts

| Suite | Result |
| --- | --- |
| Full `npm test` before audit patches | **690 pass / 0 fail** |
| Full `npm test` after patches + audit tests | **711 pass / 0 fail** |
| `node --test dist/test/audit-*.test.js` | **21 pass / 0 fail** |
| `npm run typecheck` | **PASS** |
| `npm audit --omit=dev --audit-level=high` | **0 vulnerabilities** |

---

## Mainnet readiness risks (prioritized)

1. Permissioned validator set / correlated failure (ZC-AUD-007).
2. Lack of independent human consensus audit (ZC-AUD-010).
3. Unique-hash / edge lock durability (ZC-AUD-009).
4. Embedding RPC without CLI binding guards (ZC-AUD-008).
5. Operational key custody, peer auth, and public-testnet activation flags still fail-closed placeholders.

## Known limitations of this audit

- Single continuous automated pass; not a substitute for multi-week human review.
- P2P eclipse and long soak chaos not re-executed beyond existing suites.
- Bounded consensus explorer is not exhaustive for all N.
- No mainnet keys, genesis ceremony, or live network observed.

## Next actions

1. Human review of audit branch patches (esp. ZC-AUD-001).
2. Close or explicitly accept ZC-AUD-008/009 with tests.
3. Commission independent consensus reviewer per `docs/consensus-review/`.
4. Keep PR #904 draft until external review + N≥4 operator plan.
5. Push branch when credentials available — see [`PUSH_INSTRUCTIONS.md`](./PUSH_INSTRUCTIONS.md).

---

## Branch tip

Audit commit tip: `fcc27ee0d3e83c16af80bf141d6d3e7eda68c0d8`.

Verify with:

```bash
git rev-parse HEAD
git log --oneline -5
```
