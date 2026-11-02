// Open-testnet durable lag detector.
//
// Pure function, no I/O and no clock: the caller (the snapshot keeper) passes
// samples and, optionally, `now`. Ops wires it into the keeper poll loop.
//
//   detect(samples, opts) -> { alarm, reason, lag, staleMs }
//
// samples: array of { ts (ms epoch), height, durableHeight }, oldest first.
// opts:    { maxLag = 20, consecutive = 3, staleMinutes = 20, now = last ts }
//
// Reasons (checked in this order):
//   'lag'   - the last `consecutive` valid samples each have
//             maxHeightSeenSoFar - durableHeight > maxLag.
//   'stale' - durableHeight has not advanced for more than staleMinutes up to
//             `now`, AND height advanced in that window. If height is frozen
//             too (whole chain halted, not a durability gap) no stale alarm.
//   'insufficient-data' - no valid samples (alarm: false).
//   null    - healthy.
//
// Input rules:
//   - samples must be an array; ts must be finite and strictly increasing
//     across all samples, otherwise detect() throws (TypeError / RangeError).
//   - a sample whose height or durableHeight is missing or not a finite number
//     is skipped: ignored, never alarms, never breaks or extends a lag run.
//   - `now` earlier than the last ts throws.
//
// lag:     maxHeightSeen - durableHeight of the last valid sample (null if none).
// staleMs: now - ts of the first sample at the current durableHeight (null if none).

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const DEFAULTS = Object.freeze({ maxLag: 20, consecutive: 3, staleMinutes: 20 });

export function detect(samples, opts = {}) {
  if (!Array.isArray(samples)) throw new TypeError("samples must be an array");
  const maxLag = opts.maxLag ?? DEFAULTS.maxLag;
  const consecutive = opts.consecutive ?? DEFAULTS.consecutive;
  const staleMinutes = opts.staleMinutes ?? DEFAULTS.staleMinutes;
  if (typeof maxLag !== "number" || Number.isNaN(maxLag) || maxLag < 0) throw new RangeError("maxLag must be a number >= 0");
  if (!Number.isInteger(consecutive) || consecutive < 1) throw new RangeError("consecutive must be an integer >= 1");
  if (typeof staleMinutes !== "number" || Number.isNaN(staleMinutes) || staleMinutes <= 0) throw new RangeError("staleMinutes must be > 0");

  let prevTs = -Infinity;
  for (const s of samples) {
    if (!s || !isNum(s.ts)) throw new TypeError("every sample needs a finite numeric ts");
    if (s.ts <= prevTs) throw new RangeError(`ts must be strictly increasing (${s.ts} after ${prevTs})`);
    prevTs = s.ts;
  }
  const now = opts.now ?? (samples.length ? prevTs : undefined);
  if (now !== undefined && !isNum(now)) throw new TypeError("now must be a finite number");
  if (samples.length && now < prevTs) throw new RangeError("now is earlier than the last sample");

  const valid = samples.filter((s) => isNum(s.height) && isNum(s.durableHeight));
  if (valid.length === 0) return { alarm: false, reason: "insufficient-data", lag: null, staleMs: null };

  let maxH = -Infinity;
  let run = 0;
  let lag = 0;
  let maxD = -Infinity;
  let durableSince = null; // first sample at the current max durable height
  let heightAtDurableSince = null;
  for (const s of valid) {
    maxH = Math.max(maxH, s.height);
    lag = maxH - s.durableHeight;
    run = lag > maxLag ? run + 1 : 0;
    if (s.durableHeight > maxD) {
      maxD = s.durableHeight;
      durableSince = s.ts;
      heightAtDurableSince = maxH;
    }
  }
  const staleMs = now - durableSince;

  if (run >= consecutive) return { alarm: true, reason: "lag", lag, staleMs };
  if (staleMs > staleMinutes * 60_000 && maxH > heightAtDurableSince) {
    return { alarm: true, reason: "stale", lag, staleMs };
  }
  return { alarm: false, reason: null, lag, staleMs };
}
