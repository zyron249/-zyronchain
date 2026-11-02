// Preloaded into each open-testnet validator (node --require) so the gateway
// can show the validator's own V8 memory in GET /health without touching
// l1/src. Every 15 s it writes process.memoryUsage() as one JSON line to the
// plain pipe the gateway opened on ZYRON_VALIDATOR_MEMORY_FD (fd 3). It is
// not Node's IPC channel: the gateway parses each line itself with a size
// cap, so a malformed or oversized line cannot crash it.
// Writes go through a non-blocking net.Socket on the fd (not fs.write, whose
// blocking write on a libuv worker thread could hang process.exit and SIGTERM
// handlers if the gateway stops draining the pipe). While anything is still
// queued (writableLength > 0) new reports are dropped, so at most one report
// is ever buffered. Socket and timers are unref'd, so this never keeps a
// validator alive or delays its exit; a missing or closed pipe is a no-op.
"use strict";
const fs = require("node:fs");
const net = require("node:net");
const INTERVAL_MS = 15_000;
const fd = Number(process.env.ZYRON_VALIDATOR_MEMORY_FD);
// Grandchildren must not learn the descriptor (libuv already closes it on exec).
delete process.env.ZYRON_VALIDATOR_MEMORY_FD;
let ok = false;
if (Number.isSafeInteger(fd) && fd > 2) { try { const st = fs.fstatSync(fd); ok = st.isFIFO() || st.isSocket(); } catch { ok = false; } }
if (ok) {
  let socket;
  try { socket = new net.Socket({ fd, readable: false, writable: true }); socket.on("error", () => { ok = false; }); socket.on("close", () => { ok = false; }); socket.unref(); } catch { ok = false; }
  const report = () => {
    if (!ok || !socket || socket.destroyed || socket.writableLength > 0) return;
    try {
      const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
      socket.write(JSON.stringify({ type: "zyron-validator-memory", rss, heapTotal, heapUsed, external, arrayBuffers }) + "\n");
    } catch { ok = false; }
  };
  setTimeout(report, 1_000).unref();
  setInterval(report, INTERVAL_MS).unref();
}
