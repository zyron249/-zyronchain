export function validatorClockFaults(summary) {
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.nodes)) return [];
  return summary.nodes
    .filter((node) => Array.isArray(node?.readiness?.reasons) && node.readiness.reasons.includes("validator-clock-unhealthy"))
    .map((node) => Number(node.validator))
    .filter((validator) => Number.isSafeInteger(validator) && validator >= 1);
}

function defaultSleep(ms) {
  return new Promise((resolveSleep) => {
    const timer = setTimeout(resolveSleep, ms);
    timer.unref();
  });
}

export async function monitorValidatorClockHealth({
  sample,
  onFault,
  isStopping = () => false,
  intervalMs = 2_000,
  sleep = defaultSleep
}) {
  if (typeof sample !== "function" || typeof onFault !== "function" || typeof isStopping !== "function") {
    throw new Error("Invalid validator clock monitor callbacks");
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("Invalid validator clock monitor interval");

  while (!isStopping()) {
    try {
      const summary = await sample();
      const faults = validatorClockFaults(summary);
      if (faults.length) {
        await onFault(faults);
        return faults;
      }
    } catch (error) {
      // Sampling failures during startup/redeploy are not themselves evidence of a clock rollback.
      // Only the explicit validator-clock-unhealthy readiness reason triggers the safety action.
      if (isStopping()) return [];
    }
    if (!isStopping()) await sleep(intervalMs);
  }
  return [];
}
