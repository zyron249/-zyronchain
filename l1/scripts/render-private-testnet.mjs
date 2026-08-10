#!/usr/bin/env node
import { startValidatorClockMonitor } from "./render-clock-failstop-monitor.mjs";

const smokeMode = process.argv.includes("--smoke");
await import("./render-private-testnet-base.mjs");

if (!smokeMode) {
  const gatewayPort = Number(process.env.PORT ?? 10000);
  if (!Number.isSafeInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65535) {
    throw new Error("PORT must be a valid TCP port");
  }

  let clockFaulted = false;
  let terminating = false;
  process.once("beforeExit", () => {
    if (clockFaulted) process.exitCode = 70;
  });

  startValidatorClockMonitor({
    url: `http://127.0.0.1:${gatewayPort}`,
    onFault: async (validators) => {
      if (terminating) return;
      terminating = true;
      clockFaulted = true;
      process.exitCode = 70;
      console.error(`Fatal Render rehearsal clock fail-stop detected on validator(s): ${validators.join(",")}`);
      console.error("Signing safety remains fail-closed; terminating the ephemeral rehearsal instead of weakening the clock guard.");
      try {
        process.kill(process.pid, "SIGTERM");
      } catch (error) {
        console.error(`Unable to signal rehearsal shutdown after clock fail-stop: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
}
