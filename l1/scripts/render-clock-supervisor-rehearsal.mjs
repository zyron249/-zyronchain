#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const supervisorPath = resolve(l1Root, "scripts/render-clock-failstop-supervisor.mjs");
let requests = 0;

const server = createServer((_request, response) => {
  requests += 1;
  const faulted = requests >= 2;
  const body = {
    ready: !faulted,
    readyCount: faulted ? 3 : 4,
    sameGenesis: true,
    maxHeight: 1,
    nodes: Array.from({ length: 4 }, (_, index) => ({
      validator: index + 1,
      ready: !(faulted && index === 2),
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

const child = spawn(process.execPath, [supervisorPath, "--test-monitor-only"], {
  cwd: l1Root,
  env: {
    ...process.env,
    PORT: "10000",
    ZYRON_SUPERVISOR_TEST_URL: `http://127.0.0.1:${address.port}`
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let stderr = "";
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
child.stderr.on("data", (chunk) => { stderr += chunk; process.stderr.write(chunk); });

const exit = await Promise.race([
  new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal }))),
  new Promise((_, reject) => setTimeout(() => reject(new Error("Clock supervisor did not fail closed within 10 seconds")), 10_000))
]);
await new Promise((resolveClose) => server.close(resolveClose));

assert.equal(exit.code, 70, `Expected clock fail-stop exit 70, got ${JSON.stringify(exit)}`);
assert.ok(requests >= 2, `Expected healthy then faulted readiness samples, got ${requests}`);
assert.match(stderr, /Fatal Render rehearsal clock fail-stop detected on validator\(s\): 3/);
assert.match(stderr, /terminating the ephemeral rehearsal instead of weakening the clock guard/);

console.log(JSON.stringify({
  status: "ok",
  scenario: "render-clock-failstop-supervisor",
  readinessSamples: requests,
  faultedValidator: 3,
  supervisorExitCode: exit.code,
  safetyPolicy: "terminate-ephemeral-rehearsal-without-weakening-clock-guard"
}, null, 2));
