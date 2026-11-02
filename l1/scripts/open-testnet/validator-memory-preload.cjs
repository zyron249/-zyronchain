// Preloaded into each open-testnet validator (node --require) so the gateway
// can show the validator's own V8 memory in GET /health without touching
// l1/src. Sends process.memoryUsage() over the IPC channel every 15 s. The
// timer is unref'd and the channel is never ref'd, so this never keeps a
// validator alive, and a missing or closed channel is a no-op.
"use strict";
const INTERVAL_MS = 15_000;
if (typeof process.send === "function") {
  // Grandchildren must not inherit the IPC descriptor.
  delete process.env.NODE_CHANNEL_FD;
  delete process.env.NODE_CHANNEL_SERIALIZATION_MODE;
  if (process.channel && typeof process.channel.unref === "function") process.channel.unref();
  const report = () => {
    if (!process.connected) return;
    try {
      const { rss, heapTotal, heapUsed, external, arrayBuffers } = process.memoryUsage();
      process.send({ type: "zyron-validator-memory", rss, heapTotal, heapUsed, external, arrayBuffers }, () => {});
    } catch { /* channel closed */ }
  };
  setTimeout(report, 1_000).unref();
  setInterval(report, INTERVAL_MS).unref();
}
