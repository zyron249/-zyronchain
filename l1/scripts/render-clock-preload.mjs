import { basename } from "node:path";
import { monitorValidatorClockHealth } from "./render-clock-health.mjs";

const TEST_MODE = process.env.ZYRON_INLINE_CLOCK_MONITOR_TEST === "1";
const mainScript = process.argv[1] ? basename(process.argv[1]) : "";
const ACTIVE = TEST_MODE || mainScript === "render-private-testnet.mjs";
const POLL_INTERVAL_MS = TEST_MODE ? 50 : 2_000;
const READY_TIMEOUT_MS = TEST_MODE ? 500 : 1_500;
let faulted = false;
let stopping = false;

function failExitCode() {
  if (faulted) process.exitCode = 70;
}

if (ACTIVE) {
  process.on("beforeExit", failExitCode);
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });

  const port = Number(process.env.PORT ?? 10000);
  const testUrl = process.env.ZYRON_INLINE_CLOCK_MONITOR_URL;
  const baseUrl = TEST_MODE ? testUrl : `http://127.0.0.1:${port}`;
  if (!baseUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl)) {
    throw new Error("Render inline clock monitor requires a loopback readiness URL");
  }

  const sample = async () => {
    const response = await fetch(`${baseUrl}/readyz`, {
      headers: { "x-zyron-rpc-version": "1" },
      signal: AbortSignal.timeout(READY_TIMEOUT_MS)
    });
    const text = await response.text();
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  };

  void monitorValidatorClockHealth({
    sample,
    intervalMs: POLL_INTERVAL_MS,
    isStopping: () => stopping,
    onFault: async (validators) => {
      faulted = true;
      stopping = true;
      const label = validators.length ? validators.join(",") : "unknown";
      console.error(`Fatal inline Render clock fail-stop detected on validator(s): ${label}`);
      console.error("Preserving signing safety; requesting graceful launcher shutdown and forcing non-zero service exit.");
      process.kill(process.pid, "SIGTERM");
    }
  }).catch((error) => {
    if (stopping) return;
    console.error(`Inline Render clock monitor failed: ${error instanceof Error ? error.message : String(error)}`);
    faulted = true;
    stopping = true;
    process.kill(process.pid, "SIGTERM");
  });
}
