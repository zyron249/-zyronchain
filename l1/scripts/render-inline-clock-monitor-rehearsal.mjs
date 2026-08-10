#!/usr/bin/env node
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { startValidatorClockMonitor } from "./render-clock-failstop-monitor.mjs";

let requests = 0;
const server = createServer((_request, response) => {
  requests += 1;
  const faulted = requests >= 2;
  const body = {
    ready: !faulted,
    nodes: Array.from({ length: 4 }, (_, index) => ({
      validator: index + 1,
      readiness: {
        ready: !(faulted && index === 2),
        height: 1,
        reasons: faulted && index === 2 ? ["validator-clock-unhealthy"] : []
      }
    }))
  };
  const payload = JSON.stringify(body);
  response.writeHead(faulted ? 503 : 200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload)
  });
  response.end(payload);
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolveListen);
});
const address = server.address();
assert.ok(address && typeof address === "object");

let detected;
const detectedPromise = new Promise((resolveDetected) => {
  detected = resolveDetected;
});
const monitor = startValidatorClockMonitor({
  url: `http://127.0.0.1:${address.port}`,
  pollIntervalMs: 10,
  readyTimeoutMs: 500,
  onFault: async (validators) => detected(validators)
});

const validators = await Promise.race([
  detectedPromise,
  new Promise((_, reject) => setTimeout(() => reject(new Error("Inline clock monitor did not detect fault within two seconds")), 2_000))
]);
monitor.stop();
await new Promise((resolveClose) => server.close(resolveClose));

assert.deepEqual(validators, [3]);
assert.ok(requests >= 2, `Expected healthy then faulted readiness samples, got ${requests}`);

console.log(JSON.stringify({
  status: "ok",
  scenario: "render-inline-clock-monitor",
  readinessSamples: requests,
  faultedValidators: validators,
  processModel: "same-process-monitor-no-extra-long-lived-node"
}, null, 2));
