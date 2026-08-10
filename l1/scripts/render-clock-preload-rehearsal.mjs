#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const l1Root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const preloadPath = resolve(l1Root, "scripts/render-clock-preload.mjs");
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

const childProgram = `
let keepAlive = setInterval(() => {}, 1000);
process.once("SIGTERM", () => {
  clearInterval(keepAlive);
  process.exitCode = 0;
});
`;
const child = spawn(process.execPath, ["-e", childProgram], {
  cwd: l1Root,
  env: {
    ...process.env,
    NODE_OPTIONS: `--import=${preloadPath}`,
    ZYRON_INLINE_CLOCK_MONITOR_TEST: "1",
    ZYRON_INLINE_CLOCK_MONITOR_URL: `http://127.0.0.1:${address.port}`
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
  new Promise((_, reject) => setTimeout(() => reject(new Error("Inline clock preload did not terminate within 5 seconds")), 5_000))
]);
await new Promise((resolveClose) => server.close(resolveClose));

assert.ok(requests >= 2, `Expected healthy then faulted samples, got ${requests}`);
assert.equal(exit.code, 70, `Expected final exit code 70, got ${JSON.stringify(exit)}`);
assert.match(stderr, /Fatal inline Render clock fail-stop detected on validator\(s\): 3/);
assert.match(stderr, /requesting graceful launcher shutdown and forcing non-zero service exit/);

console.log(JSON.stringify({
  status: "ok",
  scenario: "render-inline-clock-preload",
  readinessSamples: requests,
  faultedValidator: 3,
  finalExitCode: exit.code,
  productionMainScriptFilter: "render-private-testnet.mjs",
  safetyPolicy: "graceful-sigterm-then-exit-70"
}, null, 2));
