// Quorum for the open TESTNET gateway's /health, /healthz and /readyz.
//
// The quorum is floor(2n/3)+1 of the ACTIVE validator set (the set governing
// the next height), so it follows `validator_update` activations instead of
// the genesis set. Validator reports (GET /validator-set) are unsigned, so the
// gateway never trusts a single report:
//
// - every report is validated (height bounded by the reporter's own tip+1,
//   size cap, key/address format, no duplicates);
// - the gateway keeps a TRUSTED set, starting at the genesis set. It moves to a
//   new set only when a quorum of the currently trusted set (up, hosted
//   validators that are members of it) report exactly the same set. A member
//   outside the genesis set is therefore only accepted when a BFT quorum of the
//   set that would have had to approve the validator_update attests that the
//   update was applied;
// - without such agreement the trusted set (genesis at first) is used and the
//   result says so (activeSetSource / activeSetFallback).
// Only hosted validators that are up AND members of the trusted set count
// toward the quorum.

export const MAX_REPORTED_VALIDATORS = 128;
const PUBLIC_KEY_RE = /^[0-9a-f]{128}$/;
const ADDRESS_RE = /^ZYN[0-9a-f]{40}$/;

/** BFT quorum size for a validator set of `n` members: floor(2n/3)+1. */
export function quorumThreshold(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid validator set size: ${n}`);
  return Math.floor((2 * n) / 3) + 1;
}

/**
 * Validate one reported set. Returns a normalized `{ height, validators, key }`
 * or undefined. `tipHeight` is the reporter's own chain height; a set can at
 * most govern tipHeight+1. `addressOf` (optional) derives the address from a
 * public key so mismatched pairs are rejected.
 */
export function validateReportedSet(set, tipHeight, { addressOf, maxValidators = MAX_REPORTED_VALIDATORS } = {}) {
  if (!set || typeof set !== "object") return undefined;
  if (!Number.isSafeInteger(tipHeight) || tipHeight < 0) return undefined;
  const { height, validators } = set;
  if (!Number.isSafeInteger(height) || height < 1 || height > tipHeight + 1) return undefined;
  if (!Array.isArray(validators) || validators.length < 1 || validators.length > maxValidators) return undefined;
  const keys = new Set(); const addresses = new Set(); const normalized = [];
  for (const v of validators) {
    if (!v || typeof v !== "object" || typeof v.publicKey !== "string" || !PUBLIC_KEY_RE.test(v.publicKey)) return undefined;
    if (v.address !== undefined && (typeof v.address !== "string" || !ADDRESS_RE.test(v.address))) return undefined;
    if (addressOf && v.address !== undefined && addressOf(v.publicKey) !== v.address) return undefined;
    if (keys.has(v.publicKey) || (v.address !== undefined && addresses.has(v.address))) return undefined;
    keys.add(v.publicKey); if (v.address !== undefined) addresses.add(v.address);
    normalized.push(v.address !== undefined ? { address: v.address, publicKey: v.publicKey } : { publicKey: v.publicKey });
  }
  return { height, validators: normalized, key: [...keys].sort().join(",") };
}

const setKey = (validators) => validators.map((v) => v.publicKey).sort().join(",");

/**
 * Stateful tracker of the trusted active set. `evaluate(statuses)` takes per
 * hosted validator `{ name, publicKey, up, height, activeSet? }`.
 */
export function createActiveSetTracker(genesisValidators, options = {}) {
  let trusted = { source: "genesis", height: 0, validators: genesisValidators.map((v) => ({ ...v })) };
  trusted.key = setKey(trusted.validators);
  return {
    get trusted() { return { source: trusted.source, height: trusted.height, validators: trusted.validators.map((v) => ({ ...v })) }; },
    evaluate(statuses) {
      const members = new Set(trusted.validators.map((v) => v.publicKey));
      const groups = new Map();
      for (const s of statuses) {
        if (!s?.up || typeof s.publicKey !== "string" || !members.has(s.publicKey)) continue;
        const report = validateReportedSet(s.activeSet, s.height, options);
        if (!report) continue;
        const group = groups.get(report.key) ?? { reporters: new Set(), height: Infinity, validators: report.validators };
        group.reporters.add(s.publicKey);
        group.height = Math.min(group.height, report.height);
        groups.set(report.key, group);
      }
      const needed = quorumThreshold(members.size);
      let agreed;
      for (const [key, group] of groups) {
        if (group.reporters.size >= needed && (!agreed || group.reporters.size > agreed.group.reporters.size)) agreed = { key, group };
      }
      if (agreed && agreed.group.height > trusted.height && (agreed.key !== trusted.key || trusted.source === "genesis")) {
        trusted = { source: "validators", height: agreed.group.height, validators: agreed.group.validators, key: agreed.key };
      }
      const activeMembers = new Set(trusted.validators.map((v) => v.publicKey));
      const quorum = quorumThreshold(activeMembers.size);
      const activeUp = statuses.filter((s) => s?.up && typeof s.publicKey === "string" && activeMembers.has(s.publicKey));
      return {
        ok: activeUp.length >= quorum,
        quorum,
        activeValidatorCount: activeMembers.size,
        activeValidatorsUp: activeUp.length,
        activeSetHeight: trusted.source === "genesis" ? null : trusted.height,
        activeSetSource: trusted.source,
        // True when no quorum of the trusted set agreed on a report this round.
        activeSetFallback: !agreed
      };
    }
  };
}

/** Stateless one-shot evaluation (fresh tracker starting at the genesis set). */
export function evaluateQuorum(statuses, genesisValidators, options) {
  return createActiveSetTracker(genesisValidators, options).evaluate(statuses);
}
