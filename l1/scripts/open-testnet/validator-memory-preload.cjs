// Preloaded into each open-testnet validator (node --require) so the gateway
// can show the validator's own V8 memory in GET /health without touching
// l1/src. Every 15 s it writes process.memoryUsage() as one JSON line to the
// plain pipe the gateway opened on ZYRON_VALIDATOR_MEMORY_FD (fd 3). It is
// not Node's IPC channel: the gateway parses each line itself with a size
// cap, so a malformed or oversized line cannot crash it. The timer is
// unref'd and writes are async, so this never keeps a validator alive or
// blocks it; a missing or closed pipe is a no-op.
"use strict";
const fs = require("node:fs");
const INTERVAL_MS = 15_000;
const fd = Number(process.env.ZYRON_VALIDATOR_MEMORY_FD);
// Grandchildren must not learn the descriptor (libuv already closes it on exec).
delete process.env.ZYRON_VALIDATOR_MEMORY_FD;
let ok = false;
if (Number.isSafeInteger(fd) && fd > 2) { try { const st = fs.fstatSync(fd); ok = st.isFIFO() || st.isSocket(); } catch { ok = false; } }
if (ok) {
  let busy = false;
  const report = () => {
    if (!ok || busy) return;
    try {
      const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
      busy = true;
      fs.write(fd, JSON.stringify({ type: "zyron-validator-memory", rss, heapTotal, heapUsed, external, arrayBuffers }) + "\n", (error) => { busy = false; if (error) ok = false; });
    } catch { busy = false; ok = false; }
  };
  setTimeout(report, 1_000).unref();
  setInterval(report, INTERVAL_MS).unref();
}
