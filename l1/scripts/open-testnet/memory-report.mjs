// Self-reported memory for GET /health and the once-a-minute log line.
// Render kills the whole instance above 512MB, so the report covers the
// gateway, every validator process and the last snapshot child.
import { readFileSync } from "node:fs";

export const MEMORY_LOG_INTERVAL_MS = 60_000;
const MB = 1024 * 1024;

export function gatewayMemory(usage = process.memoryUsage()) {
  const { rss, heapUsed, heapTotal, external, arrayBuffers } = usage;
  return { rss, heapUsed, heapTotal, external, arrayBuffers };
}

// Resident set size of another process in bytes (Linux /proc); undefined
// elsewhere or when the process is gone.
export function processRssBytes(pid, read = (path) => readFileSync(path, "utf8")) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(read(`/proc/${pid}/status`));
    return match ? Number(match[1]) * 1024 : undefined;
  } catch { return undefined; }
}

export function memoryReport({ gateway = gatewayMemory(), validators = {}, snapshotChild = null } = {}) {
  const known = Object.values(validators).filter((v) => Number.isFinite(v));
  const totalRss = gateway.rss + known.reduce((a, b) => a + b, 0);
  return { gateway, validators, snapshotChild, totalRss };
}

const mb = (bytes) => (Number.isFinite(bytes) ? (bytes / MB).toFixed(1) : "?");
// Same report in MB (one decimal) for GET /health; timestamps and flags pass through.
export function memoryReportMb(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round((value / MB) * 10) / 10 : null;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, typeof v === "number" || (v && typeof v === "object") ? memoryReportMb(v) : v]));
  return value;
}
// One compact line, e.g. "memory: total=412.3MB gw rss=80.1 heap=40.2/55.0 ext=3.1 ab=1.2 | v1=80.0 v2=81.2 | child peak=103.0".
export function formatMemoryLine(report) {
  const { gateway: g, validators, snapshotChild, totalRss } = report;
  const vs = Object.entries(validators).map(([name, rss]) => `${name}=${mb(rss)}`).join(" ");
  const child = snapshotChild?.maxRss ? ` | child peak=${mb(snapshotChild.maxRss)}` : "";
  return `memory: total=${mb(totalRss)}MB gw rss=${mb(g.rss)} heap=${mb(g.heapUsed)}/${mb(g.heapTotal)} ext=${mb(g.external)} ab=${mb(g.arrayBuffers)}${vs ? ` | ${vs}` : ""}${child}`;
}
