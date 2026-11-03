// Read-only host memory diagnostics for GET /health: is /tmp (and the data
// dir) a tmpfs counted against the container's memory, and how full is the
// cgroup. Reports only the filesystem type and mount point of those two
// paths (from /proc/mounts), cgroup v2 memory.current / memory.max, and
// memory.stat shmem. No other mount, no env, no file contents. Every value
// fails soft to null.
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const unescape = (field) => field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
export function parseMounts(text) {
  const mounts = [];
  for (const line of String(text ?? "").split("\n")) {
    const parts = line.split(" ");
    if (parts.length >= 3 && parts[1].startsWith("/")) mounts.push({ mountPoint: unescape(parts[1]), type: parts[2] });
  }
  return mounts;
}
// The mount holding `path`: the longest mount point that is a path prefix
// (the last such line wins, as with stacked mounts).
export function mountFor(mounts, path) {
  let best = null;
  for (const m of mounts) {
    const inside = m.mountPoint === "/" || path === m.mountPoint || path.startsWith(`${m.mountPoint}/`);
    if (inside && (!best || m.mountPoint.length >= best.mountPoint.length)) best = m;
  }
  return best ? { type: best.type, mountPoint: best.mountPoint } : null;
}
const toBytes = (text) => { const v = String(text ?? "").trim(); return /^\d+$/.test(v) ? Number(v) : v === "max" ? "max" : null; };
export function hostMemoryDiagnostics({ dataDir, read = (path) => readFileSync(path, "utf8"), real = (path) => realpathSync(path) } = {}) {
  const tryRead = (path) => { try { return read(path); } catch { return null; } };
  const where = (path) => { try { return real(path); } catch { return resolve(path); } };
  const mountsText = tryRead("/proc/mounts");
  const mounts = mountsText === null ? null : parseMounts(mountsText);
  const fsOf = (path) => (mounts && path ? mountFor(mounts, where(path)) : null);
  // cgroup v2: the "0::<path>" line of /proc/self/cgroup.
  let cgroupDir = null;
  const line = (tryRead("/proc/self/cgroup") ?? "").split("\n").find((l) => l.startsWith("0::"));
  if (line !== undefined) { const rel = line.slice(3).trim(); if (rel.startsWith("/") && !rel.split("/").includes("..")) cgroupDir = `/sys/fs/cgroup${rel === "/" ? "" : rel}`; }
  const cg = (name) => (cgroupDir ? tryRead(`${cgroupDir}/${name}`) : null);
  const shmemLine = (cg("memory.stat") ?? "").split("\n").find((l) => l.startsWith("shmem "));
  return {
    filesystems: { tmp: fsOf("/tmp"), dataDir: fsOf(dataDir) },
    cgroup: { memoryCurrent: toBytes(cg("memory.current")), memoryMax: toBytes(cg("memory.max")), shmem: shmemLine ? toBytes(shmemLine.slice(6)) : null }
  };
}
// /health is polled; re-read at most once per `ttlMs`.
export function createHostMemoryDiagnostics(options = {}, { ttlMs = 5_000, now = () => performance.now() } = {}) {
  let cached; let at = -Infinity;
  return () => {
    if (now() - at >= ttlMs) { try { cached = hostMemoryDiagnostics(options); } catch { cached = null; } at = now(); }
    return cached;
  };
}
