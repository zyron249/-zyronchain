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

// Resident memory of a process from Linux /proc, in bytes: Pss (shared
// file-backed pages split between the processes mapping them, from
// smaps_rollup), RssAnon (private anonymous pages) and VmRSS (counts every
// shared page in full, so summing it over validators double-counts the
// shared node binary and libraries). Missing values are undefined.
export function processMemoryBytes(pid, read = (path) => readFileSync(path, "utf8")) {
  if (pid !== "self" && (!Number.isSafeInteger(pid) || pid <= 0)) return undefined;
  const kb = (text, key) => { const m = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m").exec(text ?? ""); return m ? Number(m[1]) * 1024 : undefined; };
  let status, rollup;
  try { status = read(`/proc/${pid}/status`); } catch { /* gone or not Linux */ }
  try { rollup = read(`/proc/${pid}/smaps_rollup`); } catch { /* kernel < 4.14 or gone */ }
  if (status === undefined && rollup === undefined) return undefined;
  return { pss: kb(rollup, "Pss"), rssAnon: kb(status, "RssAnon"), vmRss: kb(status, "VmRSS") };
}
// The metric totalRss (and the RSS alarm that watches it) is built from:
// Pss when every process has it, else RssAnon, else VmRSS.
export const RESIDENT_METRICS = [["pss", "Pss"], ["rssAnon", "RssAnon"], ["vmRss", "VmRSS"]];
export function residentMetric(samples) {
  const present = samples.filter(Boolean);
  for (const [key, label] of RESIDENT_METRICS) if (present.length && present.every((s) => Number.isFinite(s[key]))) return { key, label };
  return { key: "vmRss", label: "VmRSS" };
}

// validators: name -> bytes in the metric named by totalRssMetric (null when
// down). gatewayResident is the gateway in that same metric (default: its
// memoryUsage().rss). vmRss, when given, is the VmRSS reference
// ({ gateway, validators }) and adds totalVmRss.
export function memoryReport({ gateway = gatewayMemory(), validators = {}, snapshotChild = null, gatewayResident, totalRssMetric = "VmRSS", vmRss } = {}) {
  const sum = (values) => Object.values(values ?? {}).filter((v) => Number.isFinite(v)).reduce((a, b) => a + b, 0);
  const gw = Number.isFinite(gatewayResident) ? gatewayResident : gateway.rss;
  const report = { gateway, validators, snapshotChild, totalRss: gw + sum(validators), totalRssMetric };
  if (Number.isFinite(gatewayResident)) report.gatewayResident = gatewayResident;
  if (vmRss) report.vmRss = { gateway: vmRss.gateway ?? null, validators: vmRss.validators ?? {}, total: (Number.isFinite(vmRss.gateway) ? vmRss.gateway : gateway.rss) + sum(vmRss.validators) };
  return report;
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
  const { gateway: g, validators, snapshotChild, totalRss, totalRssMetric, vmRss } = report;
  const vs = Object.entries(validators).map(([name, rss]) => `${name}=${mb(rss)}`).join(" ");
  const child = snapshotChild?.maxRss ? ` | child peak=${mb(snapshotChild.maxRss)}` : "";
  const metric = totalRssMetric && totalRssMetric !== "VmRSS" ? `(${totalRssMetric})` : "";
  const ref = vmRss && totalRssMetric !== "VmRSS" ? ` vmrss=${mb(vmRss.total)}MB` : "";
  return `memory: total${metric}=${mb(totalRss)}MB${ref} gw rss=${mb(g.rss)} heap=${mb(g.heapUsed)}/${mb(g.heapTotal)} ext=${mb(g.external)} ab=${mb(g.arrayBuffers)}${vs ? ` | ${vs}` : ""}${child}`;
}
