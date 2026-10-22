// Quorum for the open TESTNET gateway's /health, /healthz and /readyz.
//
// The quorum is floor(2n/3)+1 of the ACTIVE validator set: the set that
// governs the next height as reported by the validators themselves
// (GET /validator-set), so it follows `validator_update` activations instead
// of the genesis set. Only hosted validators that are up AND members of that
// set count toward it.

/** BFT quorum size for a validator set of `n` members: floor(2n/3)+1. */
export function quorumThreshold(n) {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`invalid validator set size: ${n}`);
  return Math.floor((2 * n) / 3) + 1;
}

function isValidatorList(value) {
  return Array.isArray(value) && value.length > 0 && value.every((v) => v && typeof v.publicKey === "string" && v.publicKey.length > 0);
}

/**
 * Pick the active set: the report from the up validator that is furthest
 * ahead (highest `activeSet.height`), falling back to `fallbackValidators`
 * (the genesis set) when no up validator reported a usable set.
 */
export function selectActiveValidatorSet(statuses, fallbackValidators) {
  let best;
  for (const status of statuses) {
    const set = status?.up ? status.activeSet : undefined;
    if (!set || !Number.isSafeInteger(set.height) || !isValidatorList(set.validators)) continue;
    if (!best || set.height > best.height) best = set;
  }
  if (best) return { source: "validators", height: best.height, validators: best.validators };
  return { source: "genesis", height: null, validators: fallbackValidators };
}

/**
 * Evaluate quorum. `statuses` are per hosted validator:
 * `{ name, publicKey, up, activeSet?: { height, validators: [{publicKey}] } }`.
 */
export function evaluateQuorum(statuses, fallbackValidators) {
  const active = selectActiveValidatorSet(statuses, fallbackValidators);
  const members = new Set(active.validators.map((v) => v.publicKey));
  const quorum = quorumThreshold(members.size);
  const activeUp = statuses.filter((s) => s.up && typeof s.publicKey === "string" && members.has(s.publicKey));
  return {
    ok: activeUp.length >= quorum,
    quorum,
    activeValidatorCount: members.size,
    activeValidatorsUp: activeUp.length,
    activeSetHeight: active.height,
    activeSetSource: active.source
  };
}
