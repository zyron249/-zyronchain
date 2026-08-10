#!/usr/bin/env node

export function validatorClockFaults(summary) {
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.nodes)) return [];
  return summary.nodes
    .filter((node) => Array.isArray(node?.readiness?.reasons) && node.readiness.reasons.includes("validator-clock-unhealthy"))
    .map((node) => Number(node.validator))
    .filter((validator) => Number.isSafeInteger(validator) && validator >= 1);
}

export function startValidatorClockMonitor({
  url,
  onFault,
  pollIntervalMs = 2_000,
  readyTimeoutMs = 1_500,
  fetchImpl = fetch
}) {
  if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) {
    throw new Error("Validator clock monitor URL must be loopback HTTP");
  }
  if (typeof onFault !== "function") throw new Error("Validator clock monitor requires onFault");
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1) throw new Error("Invalid clock monitor interval");
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs < 1) throw new Error("Invalid clock monitor timeout");

  let stopped = false;
  let timer;

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => { void tick(); }, pollIntervalMs);
    timer.unref();
  };

  const tick = async () => {
    if (stopped) return;
    try {
      const response = await fetchImpl(`${url}/readyz`, {
        headers: { "x-zyron-rpc-version": "1" },
        signal: AbortSignal.timeout(readyTimeoutMs)
      });
      const text = await response.text();
      let body;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      const faults = validatorClockFaults(body);
      if (faults.length) {
        stop();
        await onFault(faults);
        return;
      }
    } catch {
      // Startup/redeploy gaps are not clock faults. The launcher owns process-exit handling.
    }
    schedule();
  };

  schedule();
  return { stop };
}
